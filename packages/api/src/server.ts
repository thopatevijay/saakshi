import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { FastifyError } from 'fastify';
import type { Env } from './env.js';
import type { Db, Sql } from './db/client.js';
import { registerCameraRoutes } from './routes/cameras.js';
import { registerDepartmentRoutes } from './routes/departments.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTrustRoutes } from './routes/trust.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWatchlistRoutes } from './routes/watchlist.js';
import { registerPlateRoutes } from './routes/plates.js';
import { registerTraceRoutes } from './routes/trace.js';
import { HttpOsrmClient } from './services/osrm.js';
import type { CropPresigner } from './services/trace.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerStreamRoutes } from './routes/streams.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerRetentionRoutes } from './routes/retention.js';
import type { AlertEngine } from './services/alerts.js';

/**
 * The app type with the zod type provider attached. Route handlers get `request.body`,
 * `request.query` and `request.params` typed from their own schemas — that inference is the reason
 * the provider is worth having, and it only reaches handlers registered on *this* type.
 */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface HealthResponse {
  status: 'ok';
  service: 'saakshi-api';
  version: string;
  uptimeS: number;
}

const VERSION = '0.1.0';

export interface ServerOptions {
  env: Env;
  /** Omitted for a bare health-only server; the registry routes need a connection. */
  db?: Db;
  /**
   * A raw connection reserved for `LISTEN` (D2-06's cross-process alert fan-out). Omitted in tests,
   * where the engine and the routes already share one process and one bus.
   */
  listenSql?: Sql;
  /** D2-06's alert engine, so a test can drive the same bus the stream serves. Built if omitted. */
  alertEngine?: AlertEngine;
  fetchCatalogue?: (url: string, cookie: string) => Promise<unknown>;
  /**
   * Mints short-lived URLs for stored evidence crops (D2-08). Built at the composition root so no
   * route module reads object-store credentials at import time — `services/crop-url.ts` says why.
   */
  cropPresigner?: CropPresigner;
  /** Where `POST /api/v1/audit/export` writes bundles (D3-04). Defaults to `exports/`. */
  exportDir?: string;
}

export async function buildServer(options: ServerOptions): Promise<App> {
  const { env, db } = options;

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // 6 MB: a 100k-row CSV export re-imported in one request is ~4 MB. Larger estates page.
    bodyLimit: 6 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // One set of zod schemas drives validation, response serialisation and the OpenAPI document, so
  // the spec cannot describe something the server does not actually do.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: 'request did not match the schema',
        // Field-level detail, so a rejected onboarding call says which field and why rather than
        // just "400". The bulk importer reports the same shape.
        //
        // The field comes from `instancePath`, which fastify-type-provider-zod v7 emits as a JSON
        // pointer ('/declaredResolution', '/endpoints/hls') — not from `params`, which carries the
        // zod issue's metadata (expected type, regex pattern) and no path at all.
        details: error.validation.map((entry) => ({
          field: entry.instancePath.replace(/^\//, '').replaceAll('/', '.') || '(root)',
          message: entry.message ?? 'invalid value',
        })),
      });
    }
    request.log.error(error);
    const status = error.statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'internal error' : error.message,
    });
  });

  await app.register(fastifyJwt, { secret: env.JWT_SECRET });
  await app.register(fastifyMultipart, { limits: { fileSize: 6 * 1024 * 1024, files: 1 } });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'SAAKSHI Registry API',
        description:
          'Camera registry, onboarding and export. Model 1 names three onboarding paths — bulk ' +
          'import, manual entry and API — and all three are served here.',
        version: VERSION,
      },
      servers: [{ url: `http://localhost:${String(env.API_PORT)}`, description: 'local' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        {
          name: 'cameras',
          description: 'Registry CRUD, bulk import, catalogue onboarding, export',
        },
        { name: 'departments', description: 'Owning departments' },
        { name: 'sync', description: 'Catalogue ingest runs and their reports' },
        { name: 'trust', description: 'Trust scores, breakdowns and the estate distribution' },
        {
          name: 'watchlist',
          description:
            'Watchlist CRUD, CSV import, and lookup across the specified connectors. All ' +
            'providers are mocks — there is no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS ' +
            'connectivity, and no biometric data is processed anywhere in SAAKSHI.',
        },
        {
          name: 'plates',
          description:
            'Confusion-aware fuzzy plate search over sightings. Candidates are ranked ' +
            'possibilities, never identifications — docs/fuzzy-matching.md carries the measured ' +
            'precision and recall.',
        },
        {
          name: 'trace',
          description:
            "A vehicle's movement history. Sightings are observed; that they are the same " +
            'vehicle, and the path between them, are inferred — every row carries the link ' +
            'method and its confidence.',
        },
        {
          name: 'alerts',
          description:
            'The alert queue: live SSE stream, lifecycle transitions, rate-limit digests. Every ' +
            'alert carries a why-payload and a mock-provider disclaimer — a fuzzy match is never ' +
            'presented as certainty.',
        },
        {
          name: 'streams',
          description:
            'The video wall: a relayed HLS playlist per camera, its segments and AES keys, the ' +
            'detections that overlay them, and the saved layout. The relay caches immutable VOD ' +
            'objects and paces upstream concurrency, because each connected client would ' +
            'otherwise cost the department gateway its own copy of the stream.',
        },
        {
          name: 'audit',
          description:
            'The tamper-evident chain: search it, verify it, and package evidence as a bundle ' +
            'anyone can re-check offline. Append-only in the database, not merely in this API.',
        },
        {
          name: 'evidence',
          description:
            'The retention clock: which cameras covered a place at a time, whether that footage ' +
            'is still within its declared retention window, and the audited preservation queue. ' +
            'A preservation request is an instruction to the owning department, not an automatic ' +
            'retention extension — SAAKSHI does not operate any department’s recorder.',
        },
        { name: 'health', description: 'Liveness' },
        { name: 'auth', description: 'Session issuance and the signed-in user' },
      ],
    },
    transform: createJsonSchemaTransform({ skipList: ['/api/v1/docs/*', '/api/v1/docs'] }),
  });

  await app.register(fastifySwaggerUi, { routePrefix: '/api/v1/docs' });

  app.get(
    '/health',
    { schema: { tags: ['health'], summary: 'Liveness probe' } },
    (): HealthResponse => ({
      status: 'ok',
      service: 'saakshi-api',
      version: VERSION,
      uptimeS: Math.round(process.uptime()),
    }),
  );

  if (db !== undefined) {
    registerCameraRoutes(app, {
      db,
      env,
      ...(options.fetchCatalogue !== undefined ? { fetchCatalogue: options.fetchCatalogue } : {}),
    });
    registerDepartmentRoutes(app, { db });
    registerSyncRoutes(app, { db });
    registerTrustRoutes(app, { db });
    registerAuthRoutes(app, { db });
    registerWatchlistRoutes(app, { db });
    registerPlateRoutes(app, { db });
    registerTraceRoutes(app, {
      db,
      // D3-01's road graph. Constructed here rather than inside the route so a test can hand in a
      // stub, and so a deployment with no OSRM simply routes nothing rather than failing to boot.
      osrm: new HttpOsrmClient({ baseUrl: env.OSRM_URL, timeoutMs: env.OSRM_TIMEOUT_MS }),
      ...(options.cropPresigner !== undefined ? { presign: options.cropPresigner } : {}),
    });
    registerAlertRoutes(app, {
      db,
      ...(options.listenSql !== undefined ? { listenSql: options.listenSql } : {}),
      ...(options.alertEngine !== undefined ? { engine: options.alertEngine } : {}),
      ...(options.cropPresigner !== undefined ? { presign: options.cropPresigner } : {}),
    });
    registerStreamRoutes(app, { db, env });
    registerRetentionRoutes(app, { db, env });
    registerAuditRoutes(app, {
      db,
      ...(options.cropPresigner !== undefined ? { presign: options.cropPresigner } : {}),
      ...(options.exportDir !== undefined ? { exportDir: options.exportDir } : {}),
    });
  }

  return app;
}
