/**
 * Trust endpoints (D1-06).
 *
 * The score must never be a black box, and these two routes are where that promise is kept: one
 * returns a camera's current score **with the per-signal breakdown that explains it**, the other
 * returns the estate-wide distribution the map and the gap analysis read.
 */
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { App } from '../server.js';
import { cameraHealthChecks, cameras, departments } from '@saakshi/shared/db';
import { authenticate, READ_ROLES, requireRole } from '../auth.js';
import type { Db } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';
import { bandFor, loadWeights } from '../services/trust.js';

const SignalContribution = z.object({
  signal: z.string(),
  raw: z.union([z.number(), z.boolean(), z.null()]),
  quality: z.number().nullable(),
  weight: z.number(),
  points: z.number(),
  maxPoints: z.number(),
  applicable: z.boolean(),
  note: z.string(),
});

export const TrustBand = z.enum(['trusted', 'degraded', 'untrusted', 'dead']);

export const CameraTrustResponse = z.object({
  cameraId: z.uuid(),
  externalId: z.string(),
  name: z.string(),
  score: z.number().nullable(),
  band: TrustBand.nullable(),
  checkedAt: z.string().nullable(),
  /** Every signal, its raw value, its weight and the points it contributed. Sums to `score`. */
  breakdown: z.object({
    signals: z.array(SignalContribution),
    excluded: z.array(z.object({ signal: z.string(), reason: z.string() })),
    weightsVersion: z.number().nullable(),
    pointsTotal: z.number(),
  }),
  /** Daily buckets over the trend window, so degradation is visible rather than inferred. */
  trend: z.array(
    z.object({
      bucket: z.string(),
      score: z.number().nullable(),
      band: TrustBand.nullable(),
      checks: z.number().int(),
      reachableChecks: z.number().int(),
    }),
  ),
});

export const TrustSummaryResponse = z.object({
  total: z.number().int(),
  scored: z.number().int(),
  unscored: z.number().int(),
  bands: z.object({
    trusted: z.number().int(),
    degraded: z.number().int(),
    untrusted: z.number().int(),
    dead: z.number().int(),
  }),
  byDepartment: z.array(
    z.object({
      departmentId: z.uuid().nullable(),
      departmentCode: z.string().nullable(),
      total: z.number().int(),
      trusted: z.number().int(),
      degraded: z.number().int(),
      untrusted: z.number().int(),
      dead: z.number().int(),
      averageScore: z.number().nullable(),
    }),
  ),
  byDistrict: z.array(
    z.object({
      district: z.string().nullable(),
      total: z.number().int(),
      trusted: z.number().int(),
      degraded: z.number().int(),
      untrusted: z.number().int(),
      dead: z.number().int(),
      averageScore: z.number().nullable(),
    }),
  ),
});

/**
 * SQL band expression.
 *
 * Deliberately mirrors `bandFor` rather than reusing it: aggregating thirty thousand cameras in
 * JavaScript to count four buckets would pull the whole table across the wire. `trust.test.ts`
 * pins the boundaries on the TypeScript side and the summary endpoint's own test compares these
 * counts against the same `psql` query the validation gate runs, so the two cannot drift silently.
 */
const bandSql = sql<string>`
  case
    when ${cameras.trustScore} is null then 'unscored'
    when ${cameras.trustScore} >= 70 then 'trusted'
    when ${cameras.trustScore} >= 40 then 'degraded'
    else 'untrusted'
  end`;

export function registerTrustRoutes(app: App, deps: { db: Db }): void {
  const { db } = deps;
  const weights = loadWeights();

  // ── GET /cameras/:id/trust ────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/cameras/:id/trust',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['trust'],
        summary: 'Current trust score, the breakdown that explains it, and the recent trend',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
        response: {
          200: CameraTrustResponse,
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const cameraRows = await db
        .select({
          id: cameras.id,
          externalId: cameras.externalId,
          name: cameras.name,
          trustScore: cameras.trustScore,
        })
        .from(cameras)
        .where(and(eq(cameras.id, id), isNull(cameras.deletedAt)))
        .limit(1);

      const camera = cameraRows[0];
      if (camera === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
      }

      const latestRows = await db
        .select({
          checkedAt: cameraHealthChecks.checkedAt,
          trustScore: cameraHealthChecks.trustScore,
          connectable: cameraHealthChecks.connectable,
          breakdown: cameraHealthChecks.breakdown,
        })
        .from(cameraHealthChecks)
        .where(eq(cameraHealthChecks.cameraId, id))
        .orderBy(desc(cameraHealthChecks.checkedAt))
        .limit(1);

      const latest = latestRows[0];
      const trust = ((latest?.breakdown ?? {}) as Record<string, unknown>)['trust'] as
        { signals?: unknown[]; excluded?: unknown[]; weightsVersion?: number } | undefined;

      const signals = (trust?.signals ?? []) as z.infer<typeof SignalContribution>[];

      // Timescale `time_bucket` over the partitioning column. Daily buckets, because the question a
      // trend answers is "is this camera getting worse", not "what happened at 14:32".
      const trend = await db.execute<{
        bucket: string;
        score: string | null;
        checks: string;
        reachable_checks: string;
      }>(sql`
        select
          time_bucket('1 day', checked_at)::text          as bucket,
          round(avg(trust_score)::numeric, 2)::text       as score,
          count(*)::text                                  as checks,
          count(*) filter (where connectable)::text       as reachable_checks
        from camera_health_checks
        where camera_id = ${id}::uuid
          and checked_at > now() - (${request.query.days}::text || ' days')::interval
        group by 1
        order by 1 asc`);

      return {
        cameraId: camera.id,
        externalId: camera.externalId,
        name: camera.name,
        score: camera.trustScore === null ? null : Number(camera.trustScore),
        band:
          camera.trustScore === null
            ? null
            : bandFor(Number(camera.trustScore), latest?.connectable ?? true, weights),
        checkedAt: latest?.checkedAt === undefined ? null : String(latest.checkedAt),
        breakdown: {
          signals,
          excluded: (trust?.excluded ?? []) as { signal: string; reason: string }[],
          weightsVersion: trust?.weightsVersion ?? null,
          // Returned rather than left for the client to compute: "the breakdown sums to the score"
          // is a claim the API should be able to be held to.
          pointsTotal: Math.round(signals.reduce((sum, s) => sum + s.points, 0) * 100) / 100,
        },
        trend: trend.map((row) => {
          const score = row.score === null ? null : Number(row.score);
          const reachable = Number(row.reachable_checks) > 0;
          return {
            bucket: row.bucket,
            score,
            band: score === null ? null : bandFor(score, reachable, weights),
            checks: Number(row.checks),
            reachableChecks: Number(row.reachable_checks),
          };
        }),
      };
    },
  );

  // ── GET /trust/summary ────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/trust/summary',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['trust'],
        summary: 'Estate-wide trust distribution, by department and by district',
        response: { 200: TrustSummaryResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => {
      // `dead` is counted from the latest health check rather than from the score: an unreachable
      // camera's band is decided by reachability, not by arithmetic, so a stored number cannot
      // express it. Without this join a dead camera would be filed under its last good score.
      const deadIds = db.$with('dead_ids').as(
        db
          .selectDistinctOn([cameraHealthChecks.cameraId], {
            cameraId: cameraHealthChecks.cameraId,
            connectable: cameraHealthChecks.connectable,
          })
          .from(cameraHealthChecks)
          .orderBy(cameraHealthChecks.cameraId, desc(cameraHealthChecks.checkedAt)),
      );

      const effectiveBand = sql<string>`
        case
          when ${deadIds.connectable} is false then 'dead'
          else ${bandSql}
        end`;

      const rows = await db
        .with(deadIds)
        .select({
          departmentId: cameras.departmentId,
          departmentCode: departments.code,
          district: cameras.district,
          band: effectiveBand,
          score: cameras.trustScore,
        })
        .from(cameras)
        .leftJoin(departments, eq(cameras.departmentId, departments.id))
        .leftJoin(deadIds, eq(deadIds.cameraId, cameras.id))
        .where(isNull(cameras.deletedAt));

      const blank = () => ({
        total: 0,
        trusted: 0,
        degraded: 0,
        untrusted: 0,
        dead: 0,
        sum: 0,
        n: 0,
      });
      const overall = blank();
      const byDept = new Map<string, ReturnType<typeof blank> & { code: string | null }>();
      const byDist = new Map<string, ReturnType<typeof blank>>();
      let unscored = 0;

      for (const row of rows) {
        const band = row.band;
        const score = row.score === null ? null : Number(row.score);
        if (band === 'unscored') unscored += 1;

        const deptKey = row.departmentId ?? 'unassigned';
        const distKey = row.district ?? 'unassigned';
        if (!byDept.has(deptKey)) byDept.set(deptKey, { ...blank(), code: row.departmentCode });
        if (!byDist.has(distKey)) byDist.set(distKey, blank());

        for (const bucket of [overall, byDept.get(deptKey)!, byDist.get(distKey)!]) {
          bucket.total += 1;
          if (band === 'trusted') bucket.trusted += 1;
          else if (band === 'degraded') bucket.degraded += 1;
          else if (band === 'untrusted') bucket.untrusted += 1;
          else if (band === 'dead') bucket.dead += 1;
          if (score !== null) {
            bucket.sum += score;
            bucket.n += 1;
          }
        }
      }

      const avg = (b: { sum: number; n: number }): number | null =>
        b.n === 0 ? null : Math.round((b.sum / b.n) * 100) / 100;

      return {
        total: overall.total,
        scored: overall.total - unscored,
        unscored,
        bands: {
          trusted: overall.trusted,
          degraded: overall.degraded,
          untrusted: overall.untrusted,
          dead: overall.dead,
        },
        byDepartment: [...byDept.entries()].map(([key, b]) => ({
          departmentId: key === 'unassigned' ? null : key,
          departmentCode: b.code,
          total: b.total,
          trusted: b.trusted,
          degraded: b.degraded,
          untrusted: b.untrusted,
          dead: b.dead,
          averageScore: avg(b),
        })),
        byDistrict: [...byDist.entries()].map(([key, b]) => ({
          district: key === 'unassigned' ? null : key,
          total: b.total,
          trusted: b.trusted,
          degraded: b.degraded,
          untrusted: b.untrusted,
          dead: b.dead,
          averageScore: avg(b),
        })),
      };
    },
  );
}
