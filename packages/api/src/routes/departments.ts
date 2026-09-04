import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { App } from '../server.js';
import { z } from 'zod';
import { cameras, departments } from '@saakshi/shared/db';
import { authenticate, READ_ROLES, requireRole } from '../auth.js';
import type { Db } from '../db/client.js';
import { DepartmentResponse, ErrorResponse, Paginated } from './camera-contracts.js';

export function registerDepartmentRoutes(app: App, deps: { db: Db }): void {
  const { db } = deps;

  app.get(
    '/api/v1/departments',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['departments'],
        summary: 'List departments with their live camera counts',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
        response: { 200: Paginated(DepartmentResponse), 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      // Camera count is the number every onboarding conversation starts with ("how many of ours are
      // in there?"), so it comes back with the department rather than as a second round trip.
      // Counted over live cameras only — a decommissioned camera is not coverage.
      const rows = await db
        .select({
          id: departments.id,
          code: departments.code,
          name: departments.name,
          contactJson: departments.contactJson,
          createdAt: departments.createdAt,
          cameraCount: sql<number>`count(${cameras.id})`,
        })
        .from(departments)
        .leftJoin(
          cameras,
          sql`${eq(cameras.departmentId, departments.id)} and ${isNull(cameras.deletedAt)}`,
        )
        .groupBy(departments.id)
        .orderBy(asc(departments.code))
        .limit(request.query.limit);

      return {
        data: rows.map((r) => ({
          ...r,
          createdAt: String(r.createdAt),
          contactJson: (r.contactJson ?? {}) as Record<string, unknown>,
          cameraCount: Number(r.cameraCount),
        })),
        nextCursor: null,
        limit: request.query.limit,
      };
    },
  );
}
