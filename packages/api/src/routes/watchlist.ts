import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { watchlistEntries } from '@saakshi/shared/db';
import { z } from 'zod';
import type { App } from '../server.js';
import { authenticate, DELETE_ROLES, READ_ROLES, requireRole, WRITE_ROLES } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/client.js';
import { ErrorResponse, Paginated } from './camera-contracts.js';
import { parseCsv } from './bulk-import.js';
import {
  createWatchlistRegistry,
  upsertWatchlistEntries,
  validateWatchlistRows,
  type WatchlistRegistry,
} from '../watchlist/index.js';
import {
  LookupQuery,
  LookupResponse,
  ProvidersResponse,
  WatchlistEntryCreate,
  WatchlistEntryPatch,
  WatchlistEntryResponse,
  WatchlistImportReport,
  WatchlistListQuery,
} from './watchlist-contracts.js';

/**
 * The watchlist API: CRUD, CSV bulk import, provider health, and the lookup the alert engine and
 * the control room both call.
 *
 * Two rules run through every handler here.
 *
 * **1 · No lookup happens without a stated purpose, and every one leaves an `audit_log` row.**
 * `purpose` is a required query parameter, not a defaulted one. A watchlist is the most sensitive
 * surface in this system — it is where a camera stops being a camera and becomes a decision about a
 * person — and "who asked, and why" is the only thing that makes that reviewable afterwards. The
 * row is written on the same connection as the read, so a lookup that returns cannot fail to be
 * recorded.
 *
 * **2 · Nothing here is live.** VAHAN, SARTHI, eGujCop, AFIS and NAFIS are *specified* connectors
 * served by a mock provider. `live: false` is on every hit and every provider-health row, and the
 * disclaimer is repeated on the response body rather than left in a README, because the response
 * body is what ends up in a screenshot.
 */

export const DISCLAIMER =
  'MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity. ' +
  'These results come from the representative watchlist database this project ships. ' +
  'AFIS and NAFIS are reference-only: no biometric data is processed or stored anywhere in SAAKSHI, ' +
  'and no face recognition is performed. Connector specification: docs/watchlist-integration.md.';

export interface WatchlistRouteOptions {
  db: Db;
  /** Injected by tests and by D2-04 when it registers its confusion-aware matcher. */
  registry?: WatchlistRegistry;
}

const validNowSql = sql<boolean>`(${watchlistEntries.active}
  and ${watchlistEntries.validFrom} <= now()
  and (${watchlistEntries.validTo} is null or ${watchlistEntries.validTo} > now()))`;

const COLUMNS = {
  id: watchlistEntries.id,
  category: watchlistEntries.category,
  entityType: watchlistEntries.entityType,
  plateNormalized: watchlistEntries.plateNormalized,
  personRef: watchlistEntries.personRef,
  sourceSystem: watchlistEntries.sourceSystem,
  sourceRef: watchlistEntries.sourceRef,
  severity: watchlistEntries.severity,
  validFrom: watchlistEntries.validFrom,
  validTo: watchlistEntries.validTo,
  active: watchlistEntries.active,
  meta: watchlistEntries.meta,
  createdAt: watchlistEntries.createdAt,
  valid: validNowSql,
};

type Row = { [K in keyof typeof COLUMNS]: unknown };

function toResponse(row: Row): WatchlistEntryResponse {
  return {
    id: row.id as string,
    category: row.category as WatchlistEntryResponse['category'],
    entityType: row.entityType as WatchlistEntryResponse['entityType'],
    plateNormalized: row.plateNormalized as string | null,
    personRef: row.personRef as string | null,
    sourceSystem: row.sourceSystem as WatchlistEntryResponse['sourceSystem'],
    sourceRef: row.sourceRef as string | null,
    severity: row.severity as WatchlistEntryResponse['severity'],
    validFrom: new Date(row.validFrom as string).toISOString(),
    validTo: row.validTo === null ? null : new Date(row.validTo as string).toISOString(),
    active: row.active as boolean,
    meta: row.meta as Record<string, unknown>,
    createdAt: new Date(row.createdAt as string).toISOString(),
    valid: row.valid as boolean,
  };
}

export function registerWatchlistRoutes(app: App, options: WatchlistRouteOptions): void {
  const { db } = options;
  const registry = options.registry ?? createWatchlistRegistry({ db });

  // A department hands over a CSV, so `curl --data-binary @watchlist.csv -H 'content-type: text/csv'`
  // has to work. Fastify has no parser for it and answers 415 without one. Registered here rather
  // than in `server.ts` so the watchlist owns its own wire formats; multipart still works too.
  if (!app.hasContentTypeParser('text/csv')) {
    app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });
  }

  // ── GET /watchlist ────────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/watchlist',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary: 'List watchlist entries, filterable and keyset-paginated',
        querystring: WatchlistListQuery,
        response: {
          200: Paginated(WatchlistEntryResponse),
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const q = request.query;
      const filters: SQL[] = [];
      if (q.category !== undefined) filters.push(eq(watchlistEntries.category, q.category));
      if (q.entityType !== undefined) filters.push(eq(watchlistEntries.entityType, q.entityType));
      if (q.sourceSystem !== undefined) {
        filters.push(eq(watchlistEntries.sourceSystem, q.sourceSystem));
      }
      if (q.active !== undefined) filters.push(eq(watchlistEntries.active, q.active));
      if (q.validNow === true) filters.push(validNowSql);
      if (q.plate !== undefined && q.plate !== '') {
        const normalized = q.plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
        filters.push(sql`${watchlistEntries.plateNormalized} like ${normalized + '%'}`);
      }
      if (q.cursor !== undefined && q.cursor !== '') {
        filters.push(gt(watchlistEntries.id, q.cursor));
      }

      const rows = await db
        .select(COLUMNS)
        .from(watchlistEntries)
        .where(filters.length === 0 ? undefined : and(...filters))
        // Keyset on the primary key: stable, and flat regardless of page depth.
        .orderBy(asc(watchlistEntries.id))
        .limit(q.limit + 1);

      const page = rows.slice(0, q.limit);
      return {
        data: page.map(toResponse),
        nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
        limit: q.limit,
      };
    },
  );

  // ── GET /watchlist/providers ──────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/watchlist/providers',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary: 'Health of every registered connector — all mock, none live',
        response: { 200: ProvidersResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => ({ providers: await registry.health(), disclaimer: DISCLAIMER }),
  );

  // ── GET /watchlist/lookup/vehicle/:plate ──────────────────────────────────────────────────────
  app.get(
    '/api/v1/watchlist/lookup/vehicle/:plate',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary:
          'Look a plate up across every connector. Requires a stated purpose; always audited',
        params: z.object({ plate: z.string().min(1).max(24) }),
        querystring: LookupQuery,
        response: {
          200: LookupResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const { plate } = request.params;
      const q = request.query;
      const at = q.at === undefined ? new Date() : new Date(q.at);
      const normalized = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');

      const hits = await registry.lookupVehicle(normalized, {
        at,
        maxDistance: q.maxDistance,
        limit: q.limit,
      });

      await writeAudit(db, request.principal, {
        action: 'watchlist.lookup.vehicle',
        targetType: 'watchlist',
        targetId: normalized,
        purpose: q.purpose,
        caseRef: q.caseRef ?? null,
        params: { plate, normalized, at: at.toISOString(), maxDistance: q.maxDistance },
        resultCount: hits.length,
      });

      return {
        query: plate,
        normalized,
        at: at.toISOString(),
        maxDistance: q.maxDistance,
        hits,
        disclaimer: DISCLAIMER,
      };
    },
  );

  // ── GET /watchlist/lookup/person/:ref ─────────────────────────────────────────────────────────
  app.get(
    '/api/v1/watchlist/lookup/person/:ref',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary: 'Look a case reference up. Exact only — a reference is typed, not read by OCR',
        params: z.object({ ref: z.string().min(1).max(200) }),
        querystring: LookupQuery,
        response: {
          200: LookupResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const ref = decodeURIComponent(request.params.ref);
      const q = request.query;
      const at = q.at === undefined ? new Date() : new Date(q.at);

      const hits = await registry.lookupPerson(ref, { at, limit: q.limit });

      await writeAudit(db, request.principal, {
        action: 'watchlist.lookup.person',
        targetType: 'watchlist',
        targetId: ref,
        purpose: q.purpose,
        caseRef: q.caseRef ?? null,
        params: { ref, at: at.toISOString() },
        resultCount: hits.length,
      });

      return {
        query: ref,
        normalized: ref,
        at: at.toISOString(),
        maxDistance: 0,
        hits,
        disclaimer: DISCLAIMER,
      };
    },
  );

  // ── GET /watchlist/:id ────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/watchlist/:id',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary: 'One watchlist entry',
        params: z.object({ id: z.uuid() }),
        response: {
          200: WatchlistEntryResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const rows = await db
        .select(COLUMNS)
        .from(watchlistEntries)
        .where(eq(watchlistEntries.id, request.params.id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such watchlist entry' });
      }
      return toResponse(row);
    },
  );

  // ── POST /watchlist ───────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/watchlist',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary: 'Create an entry. Operators are read-only on the watchlist',
        body: WatchlistEntryCreate,
        response: {
          201: WatchlistEntryResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(watchlistEntries)
          .values({
            category: body.category,
            entityType: body.entityType,
            plateNormalized: body.plate ?? null,
            personRef: body.personRef ?? null,
            sourceSystem: body.sourceSystem,
            sourceRef: body.sourceRef ?? null,
            severity: body.severity,
            ...(body.validFrom !== undefined ? { validFrom: body.validFrom } : {}),
            validTo: body.validTo ?? null,
            active: body.active,
            meta: body.meta,
          })
          .returning(COLUMNS);
        const row = inserted[0];
        if (row === undefined) throw new Error('insert returned no row');

        await writeAudit(tx, request.principal, {
          action: 'watchlist.create',
          targetType: 'watchlist',
          targetId: row.id,
          purpose: `watchlist entry created (${body.category})`,
          params: { category: body.category, sourceSystem: body.sourceSystem },
          resultCount: 1,
        });
        return row;
      });

      return reply.code(201).send(toResponse(created));
    },
  );

  // ── PATCH /watchlist/:id ──────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/v1/watchlist/:id',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary: 'Update an entry',
        params: z.object({ id: z.uuid() }),
        body: WatchlistEntryPatch,
        response: {
          200: WatchlistEntryResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const patch = request.body;
      const updates: Partial<typeof watchlistEntries.$inferInsert> = {};
      if (patch.category !== undefined) updates.category = patch.category;
      if (patch.plate !== undefined) updates.plateNormalized = patch.plate;
      if (patch.personRef !== undefined) updates.personRef = patch.personRef;
      if (patch.severity !== undefined) updates.severity = patch.severity;
      if (patch.validFrom !== undefined) updates.validFrom = patch.validFrom;
      if (patch.validTo !== undefined) updates.validTo = patch.validTo;
      if (patch.active !== undefined) updates.active = patch.active;
      if (patch.meta !== undefined) updates.meta = patch.meta;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'no fields to update' });
      }

      const updated = await db.transaction(async (tx) => {
        const rows = await tx
          .update(watchlistEntries)
          .set(updates)
          .where(eq(watchlistEntries.id, request.params.id))
          .returning(COLUMNS);
        const row = rows[0];
        if (row === undefined) return undefined;

        await writeAudit(tx, request.principal, {
          action: 'watchlist.update',
          targetType: 'watchlist',
          targetId: row.id,
          purpose: `watchlist entry updated (${Object.keys(updates).join(', ')})`,
          params: { fields: Object.keys(updates) },
          resultCount: 1,
        });
        return row;
      });

      if (updated === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such watchlist entry' });
      }
      return toResponse(updated);
    },
  );

  // ── DELETE /watchlist/:id ─────────────────────────────────────────────────────────────────────
  //
  // **Deactivation, not deletion.** `alerts.watchlist_entry_id` is `ON DELETE CASCADE`, so a real
  // DELETE would take every alert the entry ever raised with it — destroying the evidence trail for
  // the decisions that were already made, which is the opposite of what an audit chain is for.
  // Setting `active = false` removes it from every lookup (`validAt` requires `active`) and leaves
  // the history intact. Documented on the endpoint so nobody has to read this comment to know.
  app.delete(
    '/api/v1/watchlist/:id',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(DELETE_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary:
          'Deactivate an entry (soft). It stops matching immediately; alerts it already raised survive',
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const done = await db.transaction(async (tx) => {
        const rows = await tx
          .update(watchlistEntries)
          .set({ active: false })
          .where(eq(watchlistEntries.id, request.params.id))
          .returning({ id: watchlistEntries.id });
        const row = rows[0];
        if (row === undefined) return false;

        await writeAudit(tx, request.principal, {
          action: 'watchlist.deactivate',
          targetType: 'watchlist',
          targetId: row.id,
          purpose: 'watchlist entry deactivated — it no longer matches, its alerts are retained',
          resultCount: 1,
        });
        return true;
      });

      if (!done) {
        return reply.code(404).send({ error: 'not_found', message: 'no such watchlist entry' });
      }
      return reply.code(204).send(null);
    },
  );

  // ── POST /watchlist/import ────────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/watchlist/import',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['watchlist'],
        summary:
          'CSV bulk import, upserted on (source_system, source_ref), per-row rejection report',
        consumes: ['multipart/form-data', 'text/csv'],
        response: {
          200: WatchlistImportReport,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      let text: string;
      if (request.isMultipart()) {
        const file = await request.file();
        if (file === undefined) {
          return reply
            .code(400)
            .send({ error: 'bad_request', message: 'multipart request has no file part' });
        }
        text = (await file.toBuffer()).toString('utf8');
      } else {
        // The `text/csv` parser hands the body through as a string. Anything else — a JSON body,
        // an empty request — has no rows to import, and saying so beats stringifying an object into
        // a CSV parser and reporting a bewildering per-row rejection list.
        if (typeof request.body !== 'string') {
          return reply.code(400).send({
            error: 'bad_request',
            message: 'send CSV as multipart/form-data or with content-type: text/csv',
          });
        }
        text = request.body;
      }

      let batch;
      try {
        batch = validateWatchlistRows(parseCsv(text));
      } catch (err) {
        return reply.code(400).send({
          error: 'bad_request',
          message: `could not parse csv: ${err instanceof Error ? err.message : 'unknown'}`,
        });
      }

      const result = await db.transaction(async (tx) => {
        const upserted = await upsertWatchlistEntries(tx, batch.valid);
        await writeAudit(tx, request.principal, {
          action: 'watchlist.import',
          targetType: 'watchlist',
          targetId: null,
          purpose: 'watchlist bulk import from CSV',
          params: { received: batch.received, rejected: batch.rejected.length },
          resultCount: upserted.inserted + upserted.updated,
        });
        return upserted;
      });

      return {
        received: batch.received,
        inserted: result.inserted,
        updated: result.updated,
        rejected: batch.rejected,
        committed: true,
      };
    },
  );
}
