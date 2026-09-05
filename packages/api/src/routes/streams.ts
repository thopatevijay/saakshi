/**
 * The video wall's server side (D3-07).
 *
 * Five routes, and the reason they are five rather than one is worth stating: a tile needs to know
 * **whether to play at all** before it opens a connection. A camera the prober could not reach must
 * render its reason, not a spinner over a socket nobody will ever answer — so the manifest is a
 * separate, cheap call, and it is the manifest, not a failed media request, that decides.
 *
 *   GET  /api/v1/streams/:id/manifest     what this camera is, what it costs to watch, and why not
 *   GET  /api/v1/streams/:id/index.m3u8   the relayed playlist, URIs rewritten back to us
 *   GET  /api/v1/streams/:id/media?u=…    one segment or one AES key, origin-checked
 *   GET  /api/v1/streams/:id/detections   sightings in a PTS window, for the overlay
 *   GET  /api/v1/streams/relay/stats      what the relay is doing to the gateway right now
 *   GET/PUT /api/v1/wall/layout           the operator's saved wall
 *
 * **Authorisation is by capability, derived rather than restated** — the pattern D2-08 set in
 * `trace.ts`. `/video-wall` is gated on `video:view` in `packages/shared/src/rbac.ts`, and an
 * auditor deliberately does not have it: *"granting live video would widen the surveillance surface
 * for no audit purpose."* Computing the role list from `can()` means this file cannot drift from the
 * navigation.
 *
 * ## The PTS rule, applied
 *
 * `/detections` takes a window in **presentation timestamps**, not wall clock. On a VOD tile
 * `video.currentTime * 1000` *is* the PTS the analytics worker recorded, so a box drawn from
 * `framePtsMs` lands on the frame it was computed from — including after a seek, and including
 * after the gateway replays a buffered GOP on reconnect, which is the exact case CLAUDE.md warns
 * turns an arrival-time clock into impossible velocities.
 */
import { z } from 'zod';
import { and, asc, count, desc, eq, gte, isNull, lte, max, sql } from 'drizzle-orm';
import { can } from '@saakshi/shared';
import {
  cameraHealthChecks,
  cameras,
  departments,
  plateReads,
  sightings,
  wallLayouts,
} from '@saakshi/shared/db';
import type { App } from '../server.js';
import type { Env } from '../env.js';
import type { Db } from '../db/client.js';
import { authenticate, requireRole, userRoles } from '../auth.js';
import { ErrorResponse } from './camera-contracts.js';
import { loadWeights } from '../services/trust.js';
import {
  RelayConfigurationError,
  RelayUpstreamError,
  StreamRelay,
  assertRelayable,
  decodeUpstreamToken,
} from '../services/stream-relay.js';
import {
  RelayStatsResponse,
  StreamDetectionsResponse,
  StreamManifest,
  WallLayout,
} from './stream-contracts.js';

/** Derived from the shared RBAC table. An auditor has no `video:view` and gets a 403 here. */
export const VIDEO_ROLES = userRoles.filter((role) => can(role, 'video:view'));

const BANDS = loadWeights().bands;

/**
 * The band, in SQL — copied in shape from `cameras.ts` and for the same reason.
 *
 * `dead` comes from the latest health check's `connectable`, never from the stored score: an
 * unreachable camera keeps its last good number, so a tile coloured from `trust_score >= 70` would
 * show green over a black rectangle. That is the false assurance Pillar 1 exists to remove, and the
 * video wall is the screen where it would be most convincing.
 */
const bandSql = sql<'trusted' | 'degraded' | 'untrusted' | 'dead' | null>`
  case
    when ${cameras.trustScore} is null then null
    when (select h.connectable
            from ${cameraHealthChecks} h
           where h.camera_id = ${cameras.id}
           order by h.checked_at desc
           limit 1) is false then 'dead'
    when ${cameras.trustScore} >= ${BANDS.trusted} then 'trusted'
    when ${cameras.trustScore} >= ${BANDS.degraded} then 'degraded'
    else 'untrusted'
  end`;

/** `1920x1080` → `{width, height}`. Anything else is treated as absent rather than guessed at. */
export function parseResolution(value: string | null): { width: number; height: number } | null {
  if (value === null) return null;
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(value.trim());
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

interface TrustSignal {
  signal?: string;
  note?: string;
  points?: number;
  maxPoints?: number;
  applicable?: boolean;
}

/**
 * The signals that cost this camera points, worst first.
 *
 * A signal that could not be judged is **excluded**, never scored zero (D1-06) — every sandbox row
 * is VOD, so the clock signal is inapplicable estate-wide and counting it against them would cost
 * each camera ten points for our own gateway being a file server. So `applicable === false` rows
 * are dropped here rather than reported as failures.
 */
/**
 * The prober's own error sentence.
 *
 * `camera_health_checks` has no `error` column — `workers/prober/db.py:_with_error` folds it into
 * the `breakdown` jsonb instead. Reading it from there rather than adding a column keeps the two
 * sides in step and means a dead tile can show *what the prober actually said*, which is the whole
 * point of AC 6.
 */
export function probeErrorFrom(breakdown: unknown): string | null {
  const value = ((breakdown ?? {}) as Record<string, unknown>)['error'];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function failingSignalsFrom(breakdown: unknown): {
  signal: string;
  note: string;
  points: number;
  maxPoints: number;
}[] {
  const trust = ((breakdown ?? {}) as Record<string, unknown>)['trust'] as
    | { signals?: TrustSignal[] }
    | undefined;

  return (trust?.signals ?? [])
    .filter((s) => s.applicable !== false && typeof s.points === 'number')
    .filter((s) => (s.points ?? 0) < (s.maxPoints ?? 0))
    .map((s) => ({
      signal: s.signal ?? 'unknown',
      note: s.note ?? '',
      points: s.points ?? 0,
      maxPoints: s.maxPoints ?? 0,
    }))
    .sort((a, b) => a.points / (a.maxPoints || 1) - b.points / (b.maxPoints || 1))
    .slice(0, 6);
}

export interface StreamRouteOptions {
  db: Db;
  env: Env;
  /** Injected by tests so the suite never reaches a gateway. */
  relay?: StreamRelay;
}

export function registerStreamRoutes(app: App, options: StreamRouteOptions): void {
  const { db, env } = options;

  const relay =
    options.relay ??
    new StreamRelay({
      template: env.SENTINEL_STREAM_TEMPLATE,
      host: env.SENTINEL_HOST,
      cookie: env.SENTINEL_PORTAL_COOKIE,
      concurrency: env.STREAM_RELAY_CONCURRENCY,
      cacheBytes: env.STREAM_RELAY_CACHE_MB * 1024 * 1024,
      readAhead: env.STREAM_RELAY_READ_AHEAD,
    });

  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  const loadCamera = async (id: string) => {
    const rows: {
      id: string;
      externalId: string;
      name: string;
      departmentCode: string | null;
      district: string | null;
      adapterKind: string;
      endpoints: unknown;
      status: string;
      catalogueStatus: string;
      trustScore: number | null;
      declaredResolution: string | null;
      band: 'trusted' | 'degraded' | 'untrusted' | 'dead' | null;
    }[] = await db
      .select({
        id: cameras.id,
        externalId: cameras.externalId,
        name: cameras.name,
        departmentCode: departments.code,
        district: cameras.district,
        adapterKind: cameras.adapterKind,
        endpoints: cameras.endpoints,
        status: cameras.status,
        catalogueStatus: cameras.catalogueStatus,
        trustScore: cameras.trustScore,
        declaredResolution: cameras.declaredResolution,
        band: bandSql,
      })
      .from(cameras)
      .leftJoin(departments, eq(departments.id, cameras.departmentId))
      .where(and(eq(cameras.id, id), isNull(cameras.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    // jsonb comes back as `unknown`; the relay wants the narrow shape and nothing else casts it.
    return { ...row, endpoints: (row.endpoints ?? {}) as Record<string, string> };
  };

  // ── GET /streams/:id/manifest ───────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/streams/:id/manifest',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'What a tile needs before it opens a connection: identity, trust, and playability',
        params: z.object({ id: z.uuid() }),
        response: { 200: StreamManifest, 404: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request, reply) => {
      const camera = await loadCamera(request.params.id);
      if (camera === null) {
        return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
      }

      const healthRows = await db
        .select({
          checkedAt: cameraHealthChecks.checkedAt,
          connectable: cameraHealthChecks.connectable,
          decodable: cameraHealthChecks.decodable,
          measuredFps: cameraHealthChecks.measuredFps,
          actualResolution: cameraHealthChecks.actualResolution,
          actualCodec: cameraHealthChecks.actualCodec,
          breakdown: cameraHealthChecks.breakdown,
        })
        .from(cameraHealthChecks)
        .where(eq(cameraHealthChecks.cameraId, camera.id))
        .orderBy(desc(cameraHealthChecks.checkedAt))
        .limit(1);
      const health = healthRows[0] ?? null;

      const sightingRows = await db
        .select({ total: count(), latestPts: max(sightings.framePtsMs), latestTs: max(sightings.ts) })
        .from(sightings)
        .where(eq(sightings.cameraId, camera.id));
      const sighting = sightingRows[0];

      const measured = parseResolution(health?.actualResolution ?? null);
      const declared = parseResolution(camera.declaredResolution);
      const source =
        measured !== null
          ? { ...measured, origin: 'measured' as const }
          : declared !== null
            ? { ...declared, origin: 'declared' as const }
            : null;

      // Playability is decided here, once, from the registry — not by letting a tile discover it by
      // opening a socket that will never answer.
      let hls: { playlist: string } | null = null;
      try {
        relay.resolve(camera);
        hls = { playlist: 'index.m3u8' };
      } catch (error) {
        if (!(error instanceof RelayConfigurationError)) throw error;
      }

      // WHEP comes from OUR edge gateway. The sandbox serves HLS only (D1-03), so a camera with no
      // `whep` endpoint in its registry row gets a sentence explaining that, not a broken player.
      const whepPath = camera.endpoints['whep'];
      const whep =
        whepPath === undefined || whepPath === ''
          ? null
          : {
              url: `${env.MEDIAMTX_WHEP_BASE}/${whepPath}/whep`,
              path: whepPath,
            };

      return {
        cameraId: camera.id,
        externalId: camera.externalId,
        name: camera.name,
        departmentCode: camera.departmentCode,
        district: camera.district,
        catalogueStatus: camera.catalogueStatus,
        status: camera.status,
        trust: {
          band: camera.band,
          score: num(camera.trustScore),
          checkedAt: health?.checkedAt ?? null,
          connectable: health?.connectable ?? null,
          decodable: health?.decodable ?? null,
          error: probeErrorFrom(health?.breakdown),
          measuredFps: num(health?.measuredFps),
          actualResolution: health?.actualResolution ?? null,
          actualCodec: health?.actualCodec ?? null,
          failingSignals: failingSignalsFrom(health?.breakdown),
        },
        source,
        hls,
        whep,
        whepUnavailable:
          whep !== null
            ? null
            : 'This camera publishes no WHEP path on the edge gateway. The government sandbox ' +
              'serves HLS over HTTPS only — it exposes neither RTSP nor WHEP (verified in D1-03) — ' +
              'so low-latency WebRTC is demonstrated against our own MediaMTX relay, not claimed ' +
              'against the sandbox.',
        sightings: {
          total: Number(sighting?.total ?? 0),
          latestPtsMs:
            sighting?.latestPts === null || sighting?.latestPts === undefined
              ? null
              : Number(sighting.latestPts),
          latestTs: sighting?.latestTs ?? null,
        },
      };
    },
  );

  // ── GET /streams/:id/index.m3u8 ─────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/streams/:id/index.m3u8',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'The camera’s HLS playlist, relayed and rewritten to point back at this API',
        params: z.object({ id: z.uuid() }),
        // No `response` map: the body is a playlist, not JSON. Same reason as `/api/v1/trace.csv`.
      },
    },
    async (request, reply): Promise<void> => {
      const camera = await loadCamera(request.params.id);
      if (camera === null) {
        reply.code(404).send({ error: 'not_found', message: 'no such camera' });
        return;
      }
      try {
        const result = await relay.playlist(camera);
        reply
          .header('content-type', result.contentType)
          // A VOD playlist is immutable, but the *relayed* one is only as good as the registry row
          // behind it, so the browser revalidates and we answer from memory.
          .header('cache-control', 'no-cache')
          .header('x-saakshi-relay', result.cached ? 'hit' : 'miss')
          .header('x-saakshi-upstream-ms', String(result.upstreamMs))
          .send(result.bytes);
      } catch (error) {
        sendRelayError(reply, error, camera.externalId);
      }
    },
  );

  // ── GET /streams/:id/media?u=… ──────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/streams/:id/media',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'One relayed segment or AES key. The target must be on the camera’s own origin.',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ u: z.string().min(1) }),
      },
    },
    async (request, reply): Promise<void> => {
      const camera = await loadCamera(request.params.id);
      if (camera === null) {
        reply.code(404).send({ error: 'not_found', message: 'no such camera' });
        return;
      }
      try {
        const upstream = relay.resolve(camera);
        const target = assertRelayable(decodeUpstreamToken(request.query.u), upstream);
        // AC 3, seen from the gateway's end: when a tile unmounts mid-segment the browser closes
        // the socket, and the upstream fetch has to stop with it. Node gives no `AbortSignal` on an
        // `IncomingMessage`, so one is bridged from the connection's own `close` event — without it
        // a wall that is paged through leaves a fetch running per abandoned tile.
        const abort = new AbortController();
        request.raw.once('close', () => {
          abort.abort();
        });
        const result = await relay.media(target, abort.signal);
        reply
          .header('content-type', result.contentType)
          .header('cache-control', 'private, max-age=3600')
          .header('x-saakshi-relay', result.cached ? 'hit' : 'miss')
          .header('x-saakshi-upstream-ms', String(result.upstreamMs))
          .send(result.bytes);
      } catch (error) {
        sendRelayError(reply, error, camera.externalId);
      }
    },
  );

  // ── GET /streams/:id/detections ─────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/streams/:id/detections',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'Detections in a presentation-timestamp window, for the tile overlay',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          // PTS, not wall clock. See the module note.
          fromPtsMs: z.coerce.number().min(0),
          toPtsMs: z.coerce.number().min(0),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: {
          200: StreamDetectionsResponse,
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const camera = await loadCamera(request.params.id);
      if (camera === null) {
        return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
      }
      const { fromPtsMs, toPtsMs, limit } = request.query;
      const [lo, hi] = fromPtsMs <= toPtsMs ? [fromPtsMs, toPtsMs] : [toPtsMs, fromPtsMs];

      const rows = await db
        .select({
          id: sightings.id,
          ptsMs: sightings.framePtsMs,
          ts: sightings.ts,
          trackId: sightings.trackId,
          class: sightings.class,
          bbox: sightings.bbox,
          confidence: sightings.detConfidence,
          vehicleColor: sightings.vehicleColor,
          plate: plateReads.normalizedText,
          plateRaw: plateReads.rawText,
          plateConfidence: plateReads.confidence,
        })
        .from(sightings)
        .leftJoin(plateReads, eq(plateReads.sightingId, sightings.id))
        .where(
          and(
            eq(sightings.cameraId, camera.id),
            gte(sightings.framePtsMs, lo),
            lte(sightings.framePtsMs, hi),
          ),
        )
        .orderBy(asc(sightings.framePtsMs))
        .limit(limit);

      return {
        cameraId: camera.id,
        fromPtsMs: lo,
        toPtsMs: hi,
        detections: rows.map((row) => {
          const bbox = (row.bbox ?? {}) as Record<string, number>;
          return {
            id: row.id,
            ptsMs: Number(row.ptsMs),
            ts: row.ts,
            trackId: row.trackId,
            class: row.class,
            bbox: {
              x: Number(bbox['x'] ?? 0),
              y: Number(bbox['y'] ?? 0),
              w: Number(bbox['w'] ?? 0),
              h: Number(bbox['h'] ?? 0),
            },
            confidence: Number(row.confidence),
            vehicleColor: row.vehicleColor,
            // The normalised form when the Indian-plate grammar accepted it, the raw read when it
            // did not. Never nothing: a rejected read is a signal, and D2-01's handoff is explicit
            // that null means *not evaluated*, never *rejected*.
            plate: row.plate ?? row.plateRaw ?? null,
            plateConfidence: row.plateConfidence === null ? null : Number(row.plateConfidence),
          };
        }),
      };
    },
  );

  // ── GET /streams/relay/stats ────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/streams/relay/stats',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'What the relay is currently doing to the upstream gateway',
        response: { 200: RelayStatsResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    () => relay.stats(),
  );

  // ── GET / PUT /wall/layout ──────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/wall/layout',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'The signed-in operator’s saved video wall',
        response: {
          200: z.object({ layout: WallLayout.nullable() }),
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.code(401).send({ error: 'unauthorized', message: 'not authenticated' });
      }
      const rows = await db
        .select({ layout: wallLayouts.layout })
        .from(wallLayouts)
        .where(eq(wallLayouts.userId, principal.sub))
        .limit(1);
      const parsed = WallLayout.safeParse(rows[0]?.layout);
      // A layout stored by an older shape is discarded, not repaired: the operator gets the default
      // wall and one save fixes it, which beats rendering half a layout nobody can explain.
      return { layout: parsed.success ? parsed.data : null };
    },
  );

  app.put(
    '/api/v1/wall/layout',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(VIDEO_ROLES)],
      schema: {
        tags: ['streams'],
        summary: 'Replace the signed-in operator’s saved video wall',
        body: WallLayout,
        response: {
          200: z.object({ layout: WallLayout }),
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.code(401).send({ error: 'unauthorized', message: 'not authenticated' });
      }
      const layout = request.body;
      await db
        .insert(wallLayouts)
        .values({ userId: principal.sub, layout })
        .onConflictDoUpdate({
          target: wallLayouts.userId,
          set: { layout, updatedAt: new Date().toISOString() },
        });
      return { layout };
    },
  );
}

/**
 * One place where a relay failure becomes a status code.
 *
 * A gateway 401 is **our** expired session cookie, not this operator's — reporting it as 401 would
 * sign an officer out of SAAKSHI because a government cookie went stale. It is a 502 with a
 * sentence, which is the same distinction D1-03 drew between `AuthError` and `UnreachableError`.
 */
function sendRelayError(
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  error: unknown,
  externalId: string,
): void {
  if (error instanceof RelayConfigurationError) {
    reply.code(503).send({
      error: 'stream_unconfigured',
      message: `${externalId} has no resolvable stream URL. ${error.message}`,
    });
    return;
  }
  if (error instanceof RelayUpstreamError) {
    reply.code(error.status).send({ error: 'stream_upstream', message: error.message });
    return;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    // The tile unmounted mid-segment. Expected, and the point of AC 3.
    reply.code(499).send({ error: 'client_closed', message: 'the client closed the connection' });
    return;
  }
  throw error;
}
