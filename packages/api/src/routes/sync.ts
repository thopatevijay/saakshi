/**
 * Sync report endpoints (D1-04).
 *
 * The report is not a log line. When the camera set changes under us — and the organisers say it
 * can, up to and including evaluation day — this is the record that says when it changed, what
 * changed, and what the upstream actually sent when it stopped making sense.
 */
import { z } from 'zod';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { App } from '../server.js';
import { catalogueSyncRuns } from '@saakshi/shared/db';
import { authenticate, READ_ROLES, requireRole } from '../auth.js';
import type { Db } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';

const RowError = z.object({
  row: z.number().int(),
  externalId: z.string().nullable(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })),
});

export const SyncRunResponse = z.object({
  id: z.uuid(),
  source: z.string(),
  departmentId: z.uuid().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  ok: z.boolean(),
  shape: z.string().nullable(),
  trigger: z.string(),
  fetched: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  wentAbsent: z.number().int(),
  returned: z.number().int(),
  rejected: z.number().int(),
  error: z.string().nullable(),
  rejections: z.array(RowError),
  /**
   * Present only on a failed run, and only when a payload actually arrived. Excluded from the list
   * response: a payload can be megabytes, and paging fifty of them to render a table would make the
   * report endpoint the slowest thing in the API.
   */
  rawPayload: z.unknown().optional(),
  /** List rows carry this flag instead of the payload itself; fetch the run by id to read it. */
  hasRawPayload: z.boolean().optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Keyset cursor, `<startedAt>|<id>`, from the previous page's `nextCursor`. */
  cursor: z.string().optional(),
  ok: z.coerce.boolean().optional(),
});

export function registerSyncRoutes(app: App, deps: { db: Db }): void {
  const { db } = deps;

  app.get(
    '/api/v1/sync/reports',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['sync'],
        summary: 'Catalogue sync runs, most recent first',
        querystring: ListQuery,
        response: {
          200: z.object({
            items: z.array(SyncRunResponse),
            nextCursor: z.string().nullable(),
          }),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { limit, cursor, ok } = request.query;

      let keyset;
      if (cursor !== undefined) {
        const split = cursor.lastIndexOf('|');
        const startedAt = split === -1 ? '' : cursor.slice(0, split);
        const id = split === -1 ? '' : cursor.slice(split + 1);
        if (startedAt === '' || id === '') {
          return reply
            .code(400)
            .send({ error: 'bad_request', message: 'cursor must be "<startedAt>|<id>"' });
        }
        // Ordering is (started_at desc, id desc), so the cursor comparison is strictly "before".
        // Comparing the tuple rather than the timestamp alone keeps the page stable when two runs
        // share a millisecond — which a scheduled sweep and a manual one on stage easily can.
        keyset = or(
          lt(catalogueSyncRuns.startedAt, startedAt),
          and(eq(catalogueSyncRuns.startedAt, startedAt), lt(catalogueSyncRuns.id, id)),
        );
      }

      const filters = [
        ...(keyset === undefined ? [] : [keyset]),
        ...(ok === undefined ? [] : [eq(catalogueSyncRuns.ok, ok)]),
      ];

      const rows = await db
        .select({
          id: catalogueSyncRuns.id,
          source: catalogueSyncRuns.source,
          departmentId: catalogueSyncRuns.departmentId,
          startedAt: catalogueSyncRuns.startedAt,
          finishedAt: catalogueSyncRuns.finishedAt,
          durationMs: catalogueSyncRuns.durationMs,
          ok: catalogueSyncRuns.ok,
          shape: catalogueSyncRuns.shape,
          trigger: catalogueSyncRuns.triggerSource,
          fetched: catalogueSyncRuns.fetched,
          added: catalogueSyncRuns.added,
          updated: catalogueSyncRuns.updated,
          unchanged: catalogueSyncRuns.unchanged,
          wentAbsent: catalogueSyncRuns.wentAbsent,
          returned: catalogueSyncRuns.returned,
          rejected: catalogueSyncRuns.rejected,
          error: catalogueSyncRuns.error,
          rejections: catalogueSyncRuns.rejections,
          // Whether a payload was kept, without carrying it. A list that streamed every failed
          // body would be the slowest endpoint in the API.
          hasRawPayload: sql<boolean>`${catalogueSyncRuns.rawPayload} is not null`,
        })
        .from(catalogueSyncRuns)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(catalogueSyncRuns.startedAt), desc(catalogueSyncRuns.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page.at(-1);

      return {
        items: page.map((row) => ({
          ...row,
          rejections: (row.rejections ?? []) as z.infer<typeof RowError>[],
        })),
        nextCursor:
          rows.length > limit && last !== undefined ? `${last.startedAt}|${last.id}` : null,
      };
    },
  );

  app.get(
    '/api/v1/sync/reports/:id',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['sync'],
        summary: 'One sync run, including the raw payload kept from an unknown-shape failure',
        params: z.object({ id: z.uuid() }),
        response: {
          200: SyncRunResponse,
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const rows = await db
        .select()
        .from(catalogueSyncRuns)
        .where(eq(catalogueSyncRuns.id, request.params.id))
        .limit(1);

      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such sync run' });
      }

      return {
        id: row.id,
        source: row.source,
        departmentId: row.departmentId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        ok: row.ok,
        shape: row.shape,
        trigger: row.triggerSource,
        fetched: row.fetched,
        added: row.added,
        updated: row.updated,
        unchanged: row.unchanged,
        wentAbsent: row.wentAbsent,
        returned: row.returned,
        rejected: row.rejected,
        error: row.error,
        rejections: (row.rejections ?? []) as z.infer<typeof RowError>[],
        rawPayload: row.rawPayload ?? undefined,
      };
    },
  );
}
