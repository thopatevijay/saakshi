import { and, asc, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { App } from '../server.js';
import { cameraHealthChecks, cameras, departments } from '@saakshi/shared/db';
import { authenticate, DELETE_ROLES, READ_ROLES, requireRole, WRITE_ROLES } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import {
  BulkImportReport,
  CameraCreate,
  CameraDetailResponse,
  CameraListQuery,
  CameraPatch,
  CameraResponse,
  CatalogueOnboardReport,
  ErrorResponse,
  Paginated,
} from './camera-contracts.js';
import { detectFormat, parseCsv, parseJsonRows, validateBatch } from './bulk-import.js';
import { z } from 'zod';

/**
 * The `location` column is `geography(Point,4326)`. Reads project it to lat/lon rather than handing
 * WKB to the client, and writes go through `ST_SetSRID(ST_MakePoint(...))` — longitude first, which
 * is the ordering everyone gets wrong exactly once.
 */
const latSql = sql<number | null>`case when ${cameras.location} is null then null
  else st_y(${cameras.location}::geometry) end`;
const lonSql = sql<number | null>`case when ${cameras.location} is null then null
  else st_x(${cameras.location}::geometry) end`;

const pointSql = (lat: number | null | undefined, lon: number | null | undefined): SQL | null =>
  lat === null || lat === undefined || lon === null || lon === undefined
    ? null
    : sql`st_setsrid(st_makepoint(${lon}, ${lat}), 4326)::geography`;

const CAMERA_COLUMNS = {
  id: cameras.id,
  externalId: cameras.externalId,
  name: cameras.name,
  departmentId: cameras.departmentId,
  departmentCode: departments.code,
  lat: latSql,
  lon: lonSql,
  address: cameras.address,
  district: cameras.district,
  cameraType: cameras.cameraType,
  mount: cameras.mount,
  geometryClass: cameras.geometryClass,
  declaredCodec: cameras.declaredCodec,
  declaredFps: cameras.declaredFps,
  declaredResolution: cameras.declaredResolution,
  vendor: cameras.vendor,
  vmsPlatform: cameras.vmsPlatform,
  retentionDays: cameras.retentionDays,
  storageType: cameras.storageType,
  adapterKind: cameras.adapterKind,
  endpoints: cameras.endpoints,
  status: cameras.status,
  trustScore: cameras.trustScore,
  onboardedAt: cameras.onboardedAt,
  updatedAt: cameras.updatedAt,
} as const;

type CameraSelect = {
  [K in keyof typeof CAMERA_COLUMNS]: unknown;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Shapes a raw row into the response contract.
 *
 * Coercion, not validation. `numeric` columns come back from postgres-js as strings and jsonb as
 * `unknown`, so both need converting — but the response is **not** parsed here, because the
 * serializer compiler already validates every response against this exact schema on the way out.
 * Doing it in the handler as well validated each row twice, which at fifty rows a request and
 * 2,000 requests a second was measurable: it was most of the per-request CPU in the benchmark.
 */
function toCameraResponse(row: CameraSelect): z.infer<typeof CameraResponse> {
  return {
    ...row,
    endpoints: (row.endpoints ?? {}) as Record<string, string>,
    lat: num(row.lat),
    lon: num(row.lon),
    declaredFps: num(row.declaredFps),
    trustScore: num(row.trustScore),
    retentionDays: num(row.retentionDays),
  } as z.infer<typeof CameraResponse>;
}

/**
 * Cursor pagination, keyed on `(onboarded_at, id)`.
 *
 * Not OFFSET: at the 100k rows this registry is benchmarked against, `OFFSET 90000` makes the
 * database walk 90,000 rows it then throws away, and the p95 target is 200 ms. A keyset cursor is
 * flat regardless of depth. `id` breaks ties so the order is total and a page boundary can never
 * drop or repeat a row.
 */
const Cursor = z.object({ onboardedAt: z.string(), id: z.uuid() });

const encodeCursor = (onboardedAt: string, id: string): string =>
  Buffer.from(JSON.stringify({ onboardedAt, id }), 'utf8').toString('base64url');

function decodeCursor(raw: string): z.infer<typeof Cursor> | null {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function buildFilters(query: CameraListQuery): SQL[] {
  // Soft-deleted cameras are invisible to every read path. Never a hard delete, never a resurrection
  // by accident.
  const filters: SQL[] = [sql`${isNull(cameras.deletedAt)}`];

  if (query.departmentId !== undefined)
    filters.push(sql`${eq(cameras.departmentId, query.departmentId)}`);
  if (query.district !== undefined) filters.push(sql`${eq(cameras.district, query.district)}`);
  if (query.cameraType !== undefined)
    filters.push(sql`${eq(cameras.cameraType, query.cameraType)}`);
  if (query.mount !== undefined) filters.push(sql`${eq(cameras.mount, query.mount)}`);
  if (query.adapterKind !== undefined)
    filters.push(sql`${eq(cameras.adapterKind, query.adapterKind)}`);
  if (query.status !== undefined) filters.push(sql`${eq(cameras.status, query.status)}`);
  if (query.geometryClass !== undefined)
    filters.push(sql`${eq(cameras.geometryClass, query.geometryClass)}`);

  if (query.trustMin !== undefined) filters.push(sql`${gte(cameras.trustScore, query.trustMin)}`);
  if (query.trustMax !== undefined) filters.push(sql`${lte(cameras.trustScore, query.trustMax)}`);

  if (query.q !== undefined) {
    const like = `%${query.q}%`;
    const clause = or(
      sql`${cameras.name} ilike ${like}`,
      sql`${cameras.externalId} ilike ${like}`,
      sql`${cameras.address} ilike ${like}`,
    );
    if (clause !== undefined) filters.push(sql`${clause}`);
  }

  if (query.bbox !== undefined) {
    // minLon,minLat,maxLon,maxLat — GeoJSON/MapLibre order, so a map viewport passes straight
    // through. ST_Intersects on a geography column uses the GiST index.
    const [minLon, minLat, maxLon, maxLat] = query.bbox.split(',').map(Number) as [
      number,
      number,
      number,
      number,
    ];
    filters.push(
      sql`st_intersects(${cameras.location}, st_makeenvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326)::geography)`,
    );
  }

  return filters;
}

interface Deps {
  db: Db;
  env: Env;
  /** Injected so tests can drive catalogue onboarding without reaching the sandbox. */
  fetchCatalogue?: (url: string, cookie: string) => Promise<unknown>;
}

export function registerCameraRoutes(app: App, deps: Deps): void {
  const { db, env } = deps;

  // ── GET /cameras ──────────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/cameras',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'List cameras with filters, cursor pagination and PostGIS bbox search',
        querystring: CameraListQuery,
        response: { 200: Paginated(CameraResponse), 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = buildFilters(query);

      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor);
        if (cursor !== null) {
          filters.push(
            sql`(${cameras.onboardedAt}, ${cameras.id}) > (${cursor.onboardedAt}::timestamptz, ${cursor.id}::uuid)`,
          );
        }
      }

      // limit + 1 to learn whether another page exists without a second COUNT query.
      const rows = await db
        .select(CAMERA_COLUMNS)
        .from(cameras)
        .leftJoin(departments, eq(cameras.departmentId, departments.id))
        .where(and(...filters))
        .orderBy(asc(cameras.onboardedAt), asc(cameras.id))
        .limit(query.limit + 1);

      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last !== undefined
          ? encodeCursor(String(last.onboardedAt), String(last.id))
          : null;

      return { data: page.map(toCameraResponse), nextCursor, limit: query.limit };
    },
  );

  // ── GET /cameras/export ───────────────────────────────────────────────────────────────────────
  // Declared before /:id so 'export' is not swallowed as an id.
  app.get(
    '/api/v1/cameras/export',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Export the registry as CSV or JSON — Model 1 sample metadata dataset',
        querystring: z.object({
          format: z.enum(['csv', 'json']).default('csv'),
          departmentId: z.uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { format, departmentId } = request.query;
      const filters: SQL[] = [sql`${isNull(cameras.deletedAt)}`];
      if (departmentId !== undefined) filters.push(sql`${eq(cameras.departmentId, departmentId)}`);

      const rows = await db
        .select(CAMERA_COLUMNS)
        .from(cameras)
        .leftJoin(departments, eq(cameras.departmentId, departments.id))
        .where(and(...filters))
        .orderBy(asc(cameras.externalId));

      const shaped = rows.map(toCameraResponse);

      await writeAudit(db, request.principal, {
        action: 'camera.export',
        targetType: 'camera',
        purpose: `registry export as ${format}`,
        params: { format, departmentId: departmentId ?? null },
        resultCount: shaped.length,
      });

      if (format === 'json') {
        return reply
          .header('content-disposition', 'attachment; filename="saakshi-cameras.json"')
          .send({ cameras: shaped });
      }

      // Column order matches fixtures/cameras-bulk-sample.csv, so an export round-trips as an
      // import. That is the Model 1 story: hand a department their own data back and let them fix it.
      const columns = [
        'externalId',
        'name',
        'departmentId',
        'lat',
        'lon',
        'address',
        'district',
        'cameraType',
        'mount',
        'geometryClass',
        'declaredCodec',
        'declaredFps',
        'declaredResolution',
        'vendor',
        'vmsPlatform',
        'retentionDays',
        'storageType',
        'adapterKind',
      ] as const;

      // The export columns are all scalars; jsonb (endpoints) is deliberately not among them,
      // because a nested object in a CSV cell is not something a department can edit and re-import.
      const escape = (v: string | number | boolean | null | undefined): string => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      };

      const csv = [
        columns.join(','),
        ...shaped.map((c) => columns.map((col) => escape(c[col])).join(',')),
      ].join('\n');

      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="saakshi-cameras.csv"')
        .send(`${csv}\n`);
    },
  );

  // ── POST /cameras/bulk ────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/cameras/bulk',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Bulk import from CSV or JSON, transactional per batch with a per-row report',
        consumes: ['multipart/form-data', 'application/json'],
        response: {
          200: BulkImportReport,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      let text: string;
      let format: 'csv' | 'json';

      if (request.isMultipart()) {
        const file = await request.file();
        if (file === undefined) {
          return reply
            .code(400)
            .send({ error: 'bad_request', message: 'multipart request has no file part' });
        }
        text = (await file.toBuffer()).toString('utf8');
        format = detectFormat(file.filename, file.mimetype);
      } else {
        // JSON body: the API onboarding path, no file involved.
        text = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        format = 'json';
      }

      let rows;
      try {
        rows = format === 'json' ? parseJsonRows(text) : parseCsv(text);
      } catch (err) {
        return reply.code(400).send({
          error: 'bad_request',
          message: `could not parse ${format}: ${err instanceof Error ? err.message : 'unknown'}`,
        });
      }

      const batch = validateBatch(rows);
      const result = await importBatch(db, batch.valid, request.principal, format);

      return {
        received: batch.received,
        imported: result.created + result.updated,
        created: result.created,
        updated: result.updated,
        rejected: batch.rejected,
        format,
        committed: true,
      };
    },
  );

  // ── POST /cameras/onboard-from-catalogue ──────────────────────────────────────────────────────
  app.post(
    '/api/v1/cameras/onboard-from-catalogue',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Pull the upstream catalogue and upsert it into the registry',
        body: z
          .object({
            departmentId: z.uuid().nullish(),
            adapterKind: z.enum(['hls', 'rtsp', 'onvif', 'whep', 'nvr', 'file']).default('hls'),
          })
          .default({ adapterKind: 'hls' }),
        response: {
          200: CatalogueOnboardReport,
          502: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      // GET /api/ingest is the contract; the URL pattern is not. It comes from config so a changed
      // upstream shape is a config edit, never a code change.
      const source = env.SENTINEL_INGEST_URL ?? `https://${env.SENTINEL_HOST}/cameras.json`;
      if (env.SENTINEL_HOST === undefined && env.SENTINEL_INGEST_URL === undefined) {
        return reply.code(502).send({
          error: 'bad_gateway',
          message: 'neither SENTINEL_INGEST_URL nor SENTINEL_HOST is configured',
        });
      }

      let payload: unknown;
      try {
        const fetcher = deps.fetchCatalogue ?? defaultFetchCatalogue;
        payload = await fetcher(source, env.SENTINEL_PORTAL_COOKIE ?? '');
      } catch (err) {
        return reply.code(502).send({
          error: 'bad_gateway',
          message: `catalogue fetch failed: ${err instanceof Error ? err.message : 'unknown'}`,
        });
      }

      // The deployed sandbox returns [{id,name}] and nothing else — no codec, no fps, no live
      // status, despite what the Integrator's Guide describes. Both shapes are accepted, and every
      // field beyond id/name stays null rather than being invented.
      const CatalogueEntry = z.object({
        id: z.union([z.string(), z.number()]).transform(String),
        name: z.string().optional(),
      });
      const entries = z
        .union([z.array(CatalogueEntry), z.object({ cameras: z.array(CatalogueEntry) })])
        .transform((v) => (Array.isArray(v) ? v : v.cameras))
        .safeParse(payload);

      if (!entries.success) {
        return reply.code(502).send({
          error: 'bad_gateway',
          message: 'catalogue payload did not match [{id,name}] or {cameras:[{id,name}]}',
        });
      }

      const batch = validateBatch(
        entries.data.map((e, idx) => ({
          row: idx + 1,
          raw: {
            externalId: e.id,
            name: e.name ?? e.id,
            adapterKind: request.body.adapterKind,
            ...(request.body.departmentId !== null && request.body.departmentId !== undefined
              ? { departmentId: request.body.departmentId }
              : {}),
          },
        })),
      );

      const result = await importBatch(db, batch.valid, request.principal, 'catalogue');

      return {
        source,
        fetched: entries.data.length,
        created: result.created,
        updated: result.updated,
        rejected: batch.rejected,
      };
    },
  );

  // ── POST /cameras ─────────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/cameras',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Manual single-camera onboarding',
        body: CameraCreate,
        response: {
          201: CameraResponse,
          409: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;

      const existing = await db
        .select({ id: cameras.id })
        .from(cameras)
        .where(
          and(
            eq(cameras.externalId, body.externalId),
            body.departmentId !== null && body.departmentId !== undefined
              ? eq(cameras.departmentId, body.departmentId)
              : isNull(cameras.departmentId),
            isNull(cameras.deletedAt),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return reply.code(409).send({
          error: 'conflict',
          message: `camera '${body.externalId}' already exists for this department`,
        });
      }

      const inserted = await db
        .insert(cameras)
        .values({
          externalId: body.externalId,
          name: body.name,
          departmentId: body.departmentId ?? null,
          location: pointSql(body.lat, body.lon) ?? undefined,
          address: body.address ?? null,
          district: body.district ?? null,
          cameraType: body.cameraType,
          mount: body.mount,
          geometryClass: body.geometryClass,
          declaredCodec: body.declaredCodec ?? null,
          declaredFps: body.declaredFps ?? null,
          declaredResolution: body.declaredResolution ?? null,
          vendor: body.vendor ?? null,
          vmsPlatform: body.vmsPlatform ?? null,
          retentionDays: body.retentionDays ?? null,
          storageType: body.storageType ?? null,
          adapterKind: body.adapterKind,
          endpoints: body.endpoints,
        })
        .returning({ id: cameras.id });

      const id = inserted[0]?.id;
      if (id === undefined) throw new Error('insert returned no id');

      await writeAudit(db, request.principal, {
        action: 'camera.create',
        targetType: 'camera',
        targetId: id,
        purpose: 'manual camera onboarding',
        params: { externalId: body.externalId, adapterKind: body.adapterKind },
        resultCount: 1,
      });

      const created = await selectOne(db, id);
      if (created === undefined) throw new Error('created camera not readable');
      return reply.code(201).send(created);
    },
  );

  // ── GET /cameras/:id ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/cameras/:id',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Camera detail with latest measured health and the declared-vs-measured delta',
        params: z.object({ id: z.uuid() }),
        response: {
          200: CameraDetailResponse,
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const camera = await selectOne(db, request.params.id);
      if (camera === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
      }

      const health = await db
        .select({
          checkedAt: cameraHealthChecks.checkedAt,
          connectable: cameraHealthChecks.connectable,
          decodable: cameraHealthChecks.decodable,
          measuredFps: cameraHealthChecks.measuredFps,
          actualResolution: cameraHealthChecks.actualResolution,
          actualCodec: cameraHealthChecks.actualCodec,
          nightUsable: cameraHealthChecks.nightUsable,
          ptsDriftMs: cameraHealthChecks.ptsDriftMs,
          trustScore: cameraHealthChecks.trustScore,
          breakdown: cameraHealthChecks.breakdown,
        })
        .from(cameraHealthChecks)
        .where(eq(cameraHealthChecks.cameraId, request.params.id))
        .orderBy(sql`${cameraHealthChecks.checkedAt} desc`)
        .limit(1);

      const latest = health[0];
      const latestHealth =
        latest === undefined
          ? null
          : {
              ...latest,
              checkedAt: String(latest.checkedAt),
              measuredFps: latest.measuredFps === null ? null : Number(latest.measuredFps),
              ptsDriftMs: latest.ptsDriftMs === null ? null : Number(latest.ptsDriftMs),
              trustScore: latest.trustScore === null ? null : Number(latest.trustScore),
              breakdown: (latest.breakdown ?? {}) as Record<string, unknown>,
            };

      return {
        ...camera,
        latestHealth,
        declaredVsMeasured:
          latestHealth === null
            ? null
            : {
                fpsDeclared: camera.declaredFps,
                fpsMeasured: latestHealth.measuredFps,
                fpsDelta:
                  camera.declaredFps === null || latestHealth.measuredFps === null
                    ? null
                    : Number((latestHealth.measuredFps - camera.declaredFps).toFixed(2)),
                resolutionDeclared: camera.declaredResolution,
                resolutionMeasured: latestHealth.actualResolution,
                resolutionMatches:
                  camera.declaredResolution === null || latestHealth.actualResolution === null
                    ? null
                    : camera.declaredResolution === latestHealth.actualResolution,
                codecDeclared: camera.declaredCodec,
                codecMeasured: latestHealth.actualCodec,
                codecMatches:
                  camera.declaredCodec === null || latestHealth.actualCodec === null
                    ? null
                    : camera.declaredCodec.toLowerCase() === latestHealth.actualCodec.toLowerCase(),
              },
      };
    },
  );

  // ── PATCH /cameras/:id ────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/v1/cameras/:id',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Update camera metadata',
        params: z.object({ id: z.uuid() }),
        body: CameraPatch,
        response: {
          200: CameraResponse,
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const existing = await selectOne(db, request.params.id);
      if (existing === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
      }

      const patch: Record<string, unknown> = { updatedAt: sql`now()` };
      const assign = <K extends keyof CameraPatch>(key: K, column: string) => {
        if (body[key] !== undefined) patch[column] = body[key];
      };

      assign('name', 'name');
      assign('departmentId', 'departmentId');
      assign('address', 'address');
      assign('district', 'district');
      assign('cameraType', 'cameraType');
      assign('mount', 'mount');
      assign('geometryClass', 'geometryClass');
      assign('declaredCodec', 'declaredCodec');
      assign('declaredFps', 'declaredFps');
      assign('declaredResolution', 'declaredResolution');
      assign('vendor', 'vendor');
      assign('vmsPlatform', 'vmsPlatform');
      assign('retentionDays', 'retentionDays');
      assign('storageType', 'storageType');
      assign('adapterKind', 'adapterKind');
      assign('endpoints', 'endpoints');

      if (body.lat !== undefined || body.lon !== undefined) {
        const lat = body.lat ?? existing.lat;
        const lon = body.lon ?? existing.lon;
        patch['location'] = pointSql(lat, lon);
      }

      await db.update(cameras).set(patch).where(eq(cameras.id, request.params.id));

      await writeAudit(db, request.principal, {
        action: 'camera.update',
        targetType: 'camera',
        targetId: request.params.id,
        purpose: 'camera metadata update',
        // Field names only, never values: an audit row is not the place to copy the payload.
        params: { fields: Object.keys(body) },
        resultCount: 1,
      });

      const updated = await selectOne(db, request.params.id);
      if (updated === undefined) throw new Error('updated camera not readable');
      return updated;
    },
  );

  // ── DELETE /cameras/:id ───────────────────────────────────────────────────────────────────────
  app.delete(
    '/api/v1/cameras/:id',
    {
      onRequest: [authenticate()],
      preHandler: [requireRole(DELETE_ROLES)],
      schema: {
        tags: ['cameras'],
        summary: 'Soft delete — the row is retained as provenance for existing sightings',
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({ id: z.uuid(), deleted: z.literal(true), deletedAt: z.string() }),
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const existing = await selectOne(db, request.params.id);
      if (existing === undefined) {
        return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
      }

      const rows = await db
        .update(cameras)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(cameras.id, request.params.id), isNull(cameras.deletedAt)))
        .returning({ deletedAt: cameras.deletedAt });

      await writeAudit(db, request.principal, {
        action: 'camera.delete',
        targetType: 'camera',
        targetId: request.params.id,
        purpose: 'camera decommissioned (soft delete)',
        params: { externalId: existing.externalId },
        resultCount: 1,
      });

      return {
        id: request.params.id,
        deleted: true as const,
        deletedAt: String(rows[0]?.deletedAt),
      };
    },
  );
}

async function selectOne(db: Db, id: string): Promise<z.infer<typeof CameraResponse> | undefined> {
  const rows = await db
    .select(CAMERA_COLUMNS)
    .from(cameras)
    .leftJoin(departments, eq(cameras.departmentId, departments.id))
    .where(and(eq(cameras.id, id), isNull(cameras.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row === undefined ? undefined : toCameraResponse(row);
}

/**
 * Writes a validated batch in **one transaction**.
 *
 * The AC is "commits nothing partial", and this is where that is guaranteed: every row and the
 * audit entry share a transaction, so a failure on row 300 of 500 leaves the registry exactly as it
 * was. Rows are upserted on `(department_id, external_id)`, so re-running the same import updates
 * instead of duplicating — that is the idempotency the AC tests for.
 *
 * `trust_score` and `status` are deliberately **not** in the update set: those are measured by the
 * prober, and a metadata re-import must never silently reset a measurement.
 */
async function importBatch(
  db: Db,
  valid: { row: number; camera: CameraCreate }[],
  principal: Parameters<typeof writeAudit>[1],
  format: string,
): Promise<{ created: number; updated: number }> {
  if (valid.length === 0) return { created: 0, updated: 0 };

  return db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;

    for (const { camera } of valid) {
      const rows = await tx
        .insert(cameras)
        .values({
          externalId: camera.externalId,
          name: camera.name,
          departmentId: camera.departmentId ?? null,
          location: pointSql(camera.lat, camera.lon) ?? undefined,
          address: camera.address ?? null,
          district: camera.district ?? null,
          cameraType: camera.cameraType,
          mount: camera.mount,
          geometryClass: camera.geometryClass,
          declaredCodec: camera.declaredCodec ?? null,
          declaredFps: camera.declaredFps ?? null,
          declaredResolution: camera.declaredResolution ?? null,
          vendor: camera.vendor ?? null,
          vmsPlatform: camera.vmsPlatform ?? null,
          retentionDays: camera.retentionDays ?? null,
          storageType: camera.storageType ?? null,
          adapterKind: camera.adapterKind,
          endpoints: camera.endpoints,
        })
        .onConflictDoUpdate({
          target: [cameras.departmentId, cameras.externalId],
          set: {
            name: camera.name,
            address: camera.address ?? null,
            district: camera.district ?? null,
            cameraType: camera.cameraType,
            mount: camera.mount,
            geometryClass: camera.geometryClass,
            declaredCodec: camera.declaredCodec ?? null,
            declaredFps: camera.declaredFps ?? null,
            declaredResolution: camera.declaredResolution ?? null,
            vendor: camera.vendor ?? null,
            vmsPlatform: camera.vmsPlatform ?? null,
            retentionDays: camera.retentionDays ?? null,
            storageType: camera.storageType ?? null,
            adapterKind: camera.adapterKind,
            endpoints: camera.endpoints,
            location: pointSql(camera.lat, camera.lon),
            updatedAt: sql`now()`,
            deletedAt: null,
          },
        })
        // xmax = 0 identifies a fresh insert; a non-zero xmax means the row was updated. It is the
        // cheapest way to get created-vs-updated counts out of one upsert.
        .returning({ id: cameras.id, isInsert: sql<boolean>`(xmax = 0)` });

      if (rows[0]?.isInsert === true) created += 1;
      else updated += 1;
    }

    await writeAudit(tx, principal, {
      action: 'camera.bulk_import',
      targetType: 'camera',
      purpose: `bulk camera onboarding via ${format}`,
      params: { format, rows: valid.length },
      resultCount: created + updated,
    });

    return { created, updated };
  });
}

async function defaultFetchCatalogue(url: string, cookie: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      // Cloudflare rejects a default programmatic UA on the sandbox host, and every path 302s
      // without the session cookie. Both were established during recon (D0-01).
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128',
      ...(cookie === '' ? {} : { cookie }),
    },
  });
  if (!response.ok) throw new Error(`upstream returned ${String(response.status)}`);
  return response.json();
}
