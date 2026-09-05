import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AlertRecord, type AlertDigest, type AlertStatus } from '@saakshi/shared';
import type { App } from '../server.js';
import { authenticate, requireRole, userRoles, type UserRole } from '../auth.js';
import { can } from '@saakshi/shared';
import type { Db, Sql } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import { createWatchlistRegistry } from '../watchlist/index.js';
import {
  ALERT_NOTIFY_CHANNEL,
  AlertEngine,
  AlertNotFoundError,
  AlertTransitionError,
  DISCLAIMER,
  rowToRecord,
  transitionAlert,
  type AlertBus,
  type AlertRow,
} from '../services/alerts.js';
import type { CropPresigner } from '../services/trace.js';
import {
  AlertDigestListResponse,
  AlertListQuery,
  AlertListResponse,
  AlertStatsResponse,
  AlertTransitionBody,
} from './alert-contracts.js';

/**
 * The alert queue's HTTP surface (D2-06).
 *
 * Four things live here and each is a deliberate choice:
 *
 * **1 · `GET /alerts/stream` is Server-Sent Events, not a WebSocket.** The traffic is one-way —
 * alerts out, nothing in — and SSE reconnects on its own, survives a proxy that only speaks HTTP,
 * and needs no client library. A WebSocket would buy bidirectionality this feature does not use and
 * cost a second protocol to operate. Lifecycle actions go over ordinary POSTs, where they can be
 * authorised and audited like every other mutation.
 *
 * **2 · The stream accepts its bearer token in the query string as well as the header.** The
 * browser's `EventSource` cannot set headers — that is a limitation of the API, not a choice D2-07
 * can code around. The token is short-lived and the alternative is a cookie, which would have to be
 * exempted from CSRF protection on a streaming endpoint. It is logged nowhere: fastify's redaction
 * covers the header, and this handler strips the parameter before the URL reaches the logger.
 *
 * **3 · Every response repeats the mock-provider disclaimer.** The response body is what ends up in
 * a screenshot, and the one claim that must never be implied is that VAHAN answered.
 *
 * **4 · Alerts are never deleted and never edited.** The only mutation is a lifecycle transition,
 * and every transition writes an `audit_log` row inside the same transaction.
 */

/**
 * Who may move an alert through its lifecycle.
 *
 * `operator` **is** included, unlike the registry's write matrix: acknowledging an alert is the
 * control-room seat's entire job, and a queue only a supervisor can clear is a queue that fills up.
 * `auditor` is excluded for the reason `auth.ts` gives — an auditor who can change the thing being
 * audited is not an auditor.
 */
export const ALERT_ACTION_ROLES: readonly UserRole[] = userRoles.filter((role) =>
  can(role, 'alerts:acknowledge'),
);

/**
 * Who may see the queue at all — derived from `alerts:view`, not from `READ_ROLES` (D3-04).
 *
 * `READ_ROLES` is every signed-in role, auditor included, so the read endpoints were serving the
 * live alert queue to a role the shared RBAC table does not grant `alerts:view` and whose navigation
 * therefore never shows the screen. That is precisely the drift `packages/shared/src/rbac.ts` warns
 * about — "the UI would keep hiding a button the server had started allowing" — and the server is
 * the authoritative side, so it is the side that moves.
 */
export const ALERT_VIEW_ROLES = userRoles.filter((role) => can(role, 'alerts:view'));

const SELECT_ALERT = sql`
  select a.id::text as id, a.watchlist_entry_id::text as watchlist_entry_id,
         a.sighting_id::text as sighting_id, a.sighting_ts, a.camera_id::text as camera_id, a.ts,
         a.match_type, a.match_distance::text as match_distance, a.confidence::text as confidence,
         a.severity, a.reason, a.dedupe_key, a.dedupe_window_start,
         a.last_seen_at, a.last_sighting_id::text as last_sighting_id, a.last_sighting_ts,
         a.sighting_count, a.last_observed_plate,
         a.status, a.acked_by::text as acked_by, a.acked_at,
         a.status_changed_at, a.status_changed_by::text as status_changed_by,
         a.created_at, false as created,
         /* D2-11. The crop as it stands NOW, not as it stood the millisecond the alert was
            raised: the plate crop rides the evidence stream and is uploaded by a different
            process, so at correlation time there is nothing to sign and it lands seconds later.
            The plate crop wins over the vehicle crop — it is the thing the alert is about. */
         coalesce(
           (select p.crop_uri from plate_reads p
             where p.sighting_id = a.last_sighting_id and p.sighting_ts = a.last_sighting_ts
               and p.crop_uri is not null
             order by p.created_at desc limit 1),
           (select s.crop_uri from sightings s
             where s.id = a.last_sighting_id and s.ts = a.last_sighting_ts
               and s.crop_uri is not null)
         ) as current_crop_uri
    from alerts a`;

export interface AlertRouteOptions {
  db: Db;
  /** The engine whose bus this stream serves. Built here when omitted. */
  engine?: AlertEngine;
  /**
   * Mints the crop URL on read (D2-11). Injected from the composition root for the reason
   * `services/crop-url.ts` documents; omitted, every crop renders as "no crop stored", which is
   * the honest answer on a machine with no object store.
   */
  presign?: CropPresigner;
  /**
   * A raw connection used only for `LISTEN`. Supplied by `index.ts`; omitted in tests, where the
   * engine and the routes already share one process and one bus.
   */
  listenSql?: Sql;
}

/** One SSE frame. `event:` first so a client can branch before parsing the payload. */
function frame(event: string, data: unknown, id?: string): string {
  const payload = JSON.stringify(data);
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${payload}\n\n`;
}

export function registerAlertRoutes(app: App, options: AlertRouteOptions): void {
  const { db } = options;
  const presign: CropPresigner = options.presign ?? (() => null);
  const toRecord = (row: AlertRow): AlertRecord => rowToRecord(row, presign);
  const engine =
    options.engine ??
    new AlertEngine({
      db,
      registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
    });
  const bus: AlertBus = engine.bus;

  // Cross-process fan-out. The consumer that raises alerts is its own process (`npm run
  // consume:sightings`), so without this an operator's stream would be empty in exactly the
  // deployment the sizing calls for. Ids only; the row is loaded here.
  if (options.listenSql !== undefined) {
    const listen = options.listenSql;
    void listen
      .listen(ALERT_NOTIFY_CHANNEL, (payload: string) => {
        void (async () => {
          try {
            const parsed = JSON.parse(payload) as { type?: string; id?: string; deduped?: boolean };
            if (typeof parsed.id !== 'string') return;
            if (parsed.type === 'digest') {
              const rows = await db.execute<Record<string, unknown>>(
                sql`select id::text as id, window_start, window_end, suppressed_count,
                           delivered_count, by_severity, by_category, by_camera, sample
                      from alert_digests where id = ${parsed.id}::uuid`,
              );
              const row = rows[0];
              if (row === undefined) return;
              bus.publish({ type: 'digest', digest: digestFromRow(row) });
              return;
            }
            const rows = await db.execute<AlertRow>(
              sql`${SELECT_ALERT} where a.id = ${parsed.id}::uuid`,
            );
            const row = rows[0];
            if (row === undefined) return;
            bus.publish({
              type: 'alert',
              alert: toRecord(row),
              deduped: parsed.deduped === true,
            });
          } catch (error) {
            app.log.warn({ err: error }, 'alert notify payload could not be replayed');
          }
        })();
      })
      .catch((error: unknown) => {
        app.log.warn(
          { err: error },
          'alert LISTEN could not be established — stream is in-process only',
        );
      });
  }

  // ── GET /alerts/stream ────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alerts/stream',
    {
      // `EventSource` cannot set an Authorization header, so the token is also accepted as a query
      // parameter and promoted onto the request before authentication runs. Stripped from the URL
      // immediately afterwards so it never reaches a log line.
      onRequest: [
        function promoteQueryToken(request, _reply, done): void {
          const token = (request.query as { access_token?: unknown } | undefined)?.access_token;
          if (
            typeof token === 'string' &&
            token !== '' &&
            request.headers.authorization === undefined
          ) {
            request.headers.authorization = `Bearer ${token}`;
            request.raw.url = (request.raw.url ?? '').replace(/([?&])access_token=[^&]*/, '$1');
          }
          done();
        },
        authenticate(db),
      ],
      preHandler: [requireRole(ALERT_VIEW_ROLES)],
      schema: {
        tags: ['alerts'],
        summary: 'Live alert stream (SSE). Events: ready · alert · digest · ping',
        description:
          'Server-Sent Events. `alert` carries one AlertRecord including its full why-payload; ' +
          '`digest` carries a rate-limit overflow summary; `ping` is a 15 s keepalive. Pass the ' +
          'bearer token in the Authorization header, or as `?access_token=` for EventSource.',
        querystring: z.object({ access_token: z.string().optional() }),
        response: { 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    (request, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer by default, which turns a live stream into a batch delivered on
        // disconnect — the failure looks exactly like "no alerts are firing".
        'x-accel-buffering': 'no',
      });

      // A reconnecting EventSource waits this long. Explicit, because the browser default is 3 s
      // in some engines and unspecified in others.
      raw.write('retry: 3000\n\n');
      raw.write(
        frame('ready', {
          service: 'saakshi-alerts',
          policyVersion: engine.policy.version,
          dedupeWindowMinutes: engine.policy.dedupe.windowMinutes,
          deliveriesPerMinute: engine.policy.rateLimit.deliveriesPerMinute,
          disclaimer: DISCLAIMER,
        }),
      );

      const unsubscribe = bus.subscribe((event) => {
        if (raw.writableEnded) return;
        raw.write(
          event.type === 'alert'
            ? frame('alert', { ...event.alert, deduped: event.deduped }, event.alert.id)
            : frame('digest', event.digest, event.digest.id),
        );
      });

      // Keepalive. Without it an idle stream is closed by every intermediate proxy after a minute,
      // and an operator's queue silently stops updating with no error anywhere.
      const ping = setInterval(() => {
        if (!raw.writableEnded) raw.write(frame('ping', { at: new Date().toISOString() }));
      }, 15_000);
      ping.unref();

      const close = (): void => {
        clearInterval(ping);
        unsubscribe();
      };
      request.raw.on('close', close);
      request.raw.on('error', close);
    },
  );

  // ── GET /alerts ───────────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alerts',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(ALERT_VIEW_ROLES)],
      schema: {
        tags: ['alerts'],
        summary: 'The alert queue, filterable and keyset-paginated',
        querystring: AlertListQuery,
        response: { 200: AlertListResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const q = request.query;
      const filters: SQL[] = [];
      if (q.status !== undefined) filters.push(sql`a.status = ${q.status}`);
      if (q.severity !== undefined) filters.push(sql`a.severity = ${q.severity}`);
      if (q.matchType !== undefined) filters.push(sql`a.match_type = ${q.matchType}`);
      if (q.cameraId !== undefined) filters.push(sql`a.camera_id = ${q.cameraId}::uuid`);
      // Resolved as a sub-select rather than a join so the keyset order and the `limit + 1`
      // look-ahead below are untouched — a join would multiply rows if a camera ever gained a
      // second department row, and the pagination contract would break silently.
      if (q.departmentId !== undefined) {
        filters.push(
          sql`a.camera_id in (select id from cameras where department_id = ${q.departmentId}::uuid)`,
        );
      }
      if (q.watchlistEntryId !== undefined) {
        filters.push(sql`a.watchlist_entry_id = ${q.watchlistEntryId}::uuid`);
      }
      if (q.category !== undefined) {
        filters.push(sql`a.reason -> 'watchlistRecord' ->> 'category' = ${q.category}`);
      }
      if (q.since !== undefined) filters.push(sql`a.last_seen_at >= ${q.since}::timestamptz`);
      if (q.until !== undefined) filters.push(sql`a.last_seen_at <= ${q.until}::timestamptz`);
      if (q.cursor !== undefined) filters.push(sql`a.last_seen_at < ${q.cursor}::timestamptz`);

      const where = filters.length === 0 ? sql`` : sql` where ${sql.join(filters, sql` and `)}`;
      // Severity order sorts on the policy's strict category rank first — five categories map onto
      // four severity levels, so severity alone silently loses the ticket's stated ordering.
      const order =
        q.sort === 'severity'
          ? sql` order by (a.reason -> 'severityBasis' ->> 'categoryRank')::int asc,
                          case a.severity when 'critical' then 0 when 'high' then 1
                                          when 'medium' then 2 else 3 end asc,
                          a.last_seen_at desc`
          : sql` order by a.last_seen_at desc`;

      const rows = await db.execute<AlertRow>(
        sql`${SELECT_ALERT}${where}${order} limit ${q.limit + 1}`,
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: page.map(toRecord),
        nextCursor:
          rows.length > q.limit && last !== undefined
            ? new Date(last.last_seen_at).toISOString()
            : null,
        limit: q.limit,
        disclaimer: DISCLAIMER,
      };
    },
  );

  // ── GET /alerts/digests ───────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alerts/digests',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(ALERT_VIEW_ROLES)],
      schema: {
        tags: ['alerts'],
        summary: 'Rate-limit overflow digests — what the queue was not shown, and why',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: AlertDigestListResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const rows = await db.execute<Record<string, unknown>>(sql`
        select id::text as id, window_start, window_end, suppressed_count, delivered_count,
               by_severity, by_category, by_camera, sample
          from alert_digests order by window_start desc limit ${request.query.limit}
      `);
      return { data: rows.map(digestFromRow), limit: request.query.limit };
    },
  );

  // ── GET /alerts/stats ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alerts/stats',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(ALERT_VIEW_ROLES)],
      schema: {
        tags: ['alerts'],
        summary: 'Queue composition, the measured dedupe ratio, and the live delivery cap',
        response: { 200: AlertStatsResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const bySeverityStatus = await db.execute<{
        severity: string;
        status: string;
        count: string;
      }>(
        sql`select severity, status, count(*)::text as count from alerts group by 1, 2 order by 1, 2`,
      );
      const byMatchType = await db.execute<{ match_type: string; count: string }>(
        sql`select match_type, count(*)::text as count from alerts group by 1 order by 1`,
      );
      const totals = await db.execute<{ alerts: string; sightings: string }>(
        sql`select (select count(*) from alerts)::text as alerts,
                   (select coalesce(sum(sighting_count), 0) from alerts)::text as sightings`,
      );
      const alerts = Number(totals[0]?.alerts ?? 0);
      const sightings = Number(totals[0]?.sightings ?? 0);
      return {
        bySeverityStatus: bySeverityStatus.map((r) => ({
          severity: r.severity as AlertStatsRow['severity'],
          status: r.status as AlertStatus,
          count: Number(r.count),
        })),
        byMatchType: byMatchType.map((r) => ({
          matchType: r.match_type as 'exact' | 'fuzzy',
          count: Number(r.count),
        })),
        total: alerts,
        totalSightings: sightings,
        dedupeRatio: sightings === 0 ? 0 : Math.round((1 - alerts / sightings) * 1e4) / 1e4,
        rateLimit: engine.gate.stats(),
        streamSubscribers: bus.listenerCount,
        policyVersion: engine.policy.version,
      };
    },
  );

  // ── GET /alerts/:id ───────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alerts/:id',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(ALERT_VIEW_ROLES)],
      schema: {
        tags: ['alerts'],
        summary: 'One alert with its complete why-payload',
        params: z.object({ id: z.uuid() }),
        response: {
          200: AlertRecord,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const rows = await db.execute<AlertRow>(
        sql`${SELECT_ALERT} where a.id = ${request.params.id}::uuid`,
      );
      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such alert' });
      }
      return toRecord(row);
    },
  );

  // ── POST /alerts/:id/transition ───────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/alerts/:id/transition',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(ALERT_ACTION_ROLES)],
      schema: {
        tags: ['alerts'],
        summary: 'Move an alert through new → ack → dismissed | escalated. Always audited',
        description:
          'Illegal transitions are refused with 409 — `dismissed` is terminal, so an alert an ' +
          'operator judged cannot be quietly reopened. Every transition writes an audit_log row ' +
          'in the same transaction as the update.',
        params: z.object({ id: z.uuid() }),
        body: AlertTransitionBody,
        response: {
          200: AlertRecord,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.code(401).send({ error: 'unauthorized', message: 'not authenticated' });
      }
      try {
        return await transitionAlert(
          db,
          request.params.id,
          request.body.to,
          principal,
          request.body.note,
        );
      } catch (error) {
        if (error instanceof AlertNotFoundError) {
          return reply.code(404).send({ error: 'not_found', message: 'no such alert' });
        }
        if (error instanceof AlertTransitionError) {
          return reply.code(409).send({ error: 'illegal_transition', message: error.message });
        }
        throw error;
      }
    },
  );
}

interface AlertStatsRow {
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: AlertStatus;
}

function digestFromRow(row: Record<string, unknown>): AlertDigest {
  const counts = (value: unknown): Record<string, number> =>
    value === null || typeof value !== 'object' ? {} : (value as Record<string, number>);
  return {
    id: String(row['id']),
    windowStart: new Date(String(row['window_start'])).toISOString(),
    windowEnd: new Date(String(row['window_end'])).toISOString(),
    suppressedCount: Number(row['suppressed_count']),
    deliveredCount: Number(row['delivered_count']),
    bySeverity: counts(row['by_severity']),
    byCategory: counts(row['by_category']),
    byCamera: counts(row['by_camera']),
    sample: Array.isArray(row['sample']) ? (row['sample'] as string[]) : [],
  };
}
