/**
 * The natural-language query endpoints (D3-09).
 *
 * **Two endpoints, and the split between them is the whole safety argument.**
 *
 * `POST /api/v1/query/compile` takes the officer's question and returns a filter. It runs no query
 * and touches no sighting.
 *
 * `POST /api/v1/query/run` takes a **filter** — and has no natural-language field at all. There is
 * no parameter an officer could put a question into, and therefore no path by which a model's
 * output reaches the database without a human having had it in their hands first. "The compiled
 * filter is shown to the officer and is editable before it runs" is usually a promise about a
 * screen; here it is a property of the API, and a screen that wanted to skip the review step could
 * not, because the run endpoint would have nothing to do.
 *
 * **Purpose binding applies (D3-04, #27).** A compiled query is still a search of a citizen's
 * movements, so `purpose` is required on both endpoints — `min(3).max(500)`, 400 if missing — and
 * the officer's badge and stated reason go into the audit chain with the raw question and the
 * compiled DSL. The model never supplies it: `purpose` is not a field in the DSL, deliberately
 * (`packages/shared/src/query-dsl.ts`), so a compiler cannot manufacture the justification for the
 * search it is itself proposing.
 *
 * Gated on `trace:run`, derived from `ROLE_CAPABILITIES` rather than restated — an **auditor gets a
 * 403**, exactly as on `/api/v1/trace`, because the audit function reviews what was done and does
 * not run investigative queries.
 */
import { z } from 'zod';
import { QueryDSL, describeQueryDsl, isUnconstrained } from '@saakshi/shared';
import type { App } from '../server.js';
import { authenticate, requireRole, type Principal } from '../auth.js';
import type { Db } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';
import { CaseReference, PurposeStatement } from './audit-contracts.js';
import { writeAudit } from '../audit.js';
import { TRACE_ROLES } from './trace.js';
import { QueryExecutor, QUERY_DISCLAIMER } from '../query/execute.js';
import { NoneCompiler, type QueryCompiler } from '../query/index.js';
import { sql } from 'drizzle-orm';

export const QUERY_ROLES = TRACE_ROLES;

/** The compile request. Note there is no schema, no SQL and no table name an officer can supply. */
export const CompileRequest = z.object({
  /** The officer's question, verbatim. Recorded; never interpolated into a query. */
  text: z.string().trim().min(3).max(1000),
  purpose: PurposeStatement,
  case_ref: CaseReference.optional(),
});

/**
 * The run request — a **filter**, and only a filter.
 *
 * `dsl` is parsed by the same `QueryDSL` schema a provider's output is parsed by, so a hand-edited
 * filter is held to exactly the standard a compiled one is. An officer widening `maxDistance` to 4
 * in the browser gets the same 400 a model would.
 */
export const RunRequest = z.object({
  dsl: QueryDSL,
  purpose: PurposeStatement,
  case_ref: CaseReference.optional(),
  /**
   * The question this filter was compiled from, when there was one, so the audit entry can carry
   * it. Optional and inert: it is recorded and never read by the query path — a hand-built filter
   * has no question behind it and that is a legitimate state.
   */
  text: z.string().trim().max(1000).optional(),
});

const CompileResponse = z.object({
  ok: z.boolean(),
  provider: z.enum(['openai', 'anthropic', 'ollama', 'none']),
  model: z.string().nullable(),
  /** The compiled filter, or `null`. `null` is not an error — the manual filter is the product. */
  dsl: QueryDSL.nullable(),
  /** One short English clause per constraint, for the editable chips. */
  summary: z.array(z.string()),
  /** True when the filter constrains nothing — worth saying out loud before it runs. */
  unconstrained: z.boolean(),
  reason: z
    .enum(['not_configured', 'provider_error', 'schema_rejected', 'not_understood'])
    .nullable(),
  message: z.string().nullable(),
  issues: z.array(z.string()),
  /** Always present on a failure. The screen has somewhere to go, always. */
  degradeTo: z.literal('manual_filter').nullable(),
  tookMs: z.number(),
  disclaimer: z.string(),
});

const ResolvedPlate = z.object({
  plate: z.string(),
  /** Weighted and fractional (D2-04, #18). Never bucketed, never rendered alone. */
  distance: z.number(),
  matchType: z.enum(['exact', 'fuzzy']),
});

const QuerySighting = z.object({
  sightingId: z.string(),
  ts: z.string(),
  framePtsMs: z.number(),
  trackId: z.number().int(),
  cameraId: z.string(),
  cameraExternalId: z.string(),
  cameraName: z.string(),
  district: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  class: z.string(),
  detConfidence: z.number(),
  vehicleColor: z.string().nullable(),
  isBestShot: z.boolean(),
  cropUri: z.string().nullable(),
  plateNormalized: z.string().nullable(),
  plateRawText: z.string().nullable(),
  ocrConfidence: z.number().nullable(),
});

const QueryCamera = z.object({
  cameraId: z.string(),
  cameraExternalId: z.string(),
  cameraName: z.string(),
  district: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  sightingCount: z.number().int(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

const RunResponse = z.object({
  entity: z.enum(['sightings', 'cameras']),
  sightings: z.array(QuerySighting),
  cameras: z.array(QueryCamera),
  resolvedPlates: z.array(ResolvedPlate),
  unknownCameras: z.array(z.string()),
  unknownDistricts: z.array(z.string()),
  rowCount: z.number().int(),
  /** An empty result is a 200 with a reason, never an error — D2-08's rule, applied here. */
  emptyReason: z
    .enum(['plate_not_searchable', 'no_matching_plate', 'unknown_camera', 'no_rows'])
    .nullable(),
  /** The SQL that ran, with `$1`, `$2` where the values went. Shown, because it is the proof. */
  sqlPreview: z.string(),
  tookMs: z.number(),
  disclaimer: z.string(),
});

export interface QueryRouteOptions {
  db: Db;
  /** Absent means `QUERY_COMPILER=none`: the manual filter, which is the primary interface. */
  compiler?: QueryCompiler;
  executor?: QueryExecutor;
}

export function registerQueryRoutes(app: App, options: QueryRouteOptions): void {
  const compiler = options.compiler ?? new NoneCompiler();
  const executor = options.executor ?? new QueryExecutor(options.db);

  app.post(
    '/api/v1/query/compile',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(QUERY_ROLES)],
      schema: {
        tags: ['query'],
        summary: 'Compile a plain-English question into an editable filter. Runs nothing.',
        description:
          'The model emits a constrained filter, never prose and never data. The filter is returned ' +
          'for the officer to review and edit; `POST /api/v1/query/run` is what executes it. A ' +
          'compiler that is unconfigured or failing returns `ok: false` with a message and ' +
          '`degradeTo: "manual_filter"` — never an error, never a silent empty result.',
        body: CompileRequest,
        response: { 200: CompileResponse, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request): Promise<z.infer<typeof CompileResponse>> => {
      const body = request.body;
      const vocabulary = await loadVocabulary(options.db);
      const outcome = await compiler.compile({ text: body.text, vocabulary });

      // Audited whether or not it compiled. An officer typing a registration into the box has
      // searched for that registration in every sense that matters to an auditor, and a compile
      // that failed is still a record of what was asked.
      await writeAudit(options.db, request.principal as Principal | undefined, {
        action: 'query.nl.compile',
        targetType: 'query',
        targetId: outcome.ok ? outcome.dsl.entity : 'rejected',
        purpose: body.purpose,
        caseRef: body.case_ref ?? null,
        params: {
          text: body.text,
          provider: outcome.provider,
          model: outcome.model,
          dsl: outcome.ok ? (outcome.dsl as unknown as Record<string, unknown>) : null,
          reason: outcome.ok ? null : outcome.reason,
          issues: outcome.ok ? [] : outcome.issues,
        },
        resultCount: 0,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          provider: outcome.provider,
          model: outcome.model,
          dsl: null,
          summary: [],
          unconstrained: false,
          reason: outcome.reason,
          message: outcome.message,
          issues: outcome.issues,
          degradeTo: outcome.degradeTo,
          tookMs: outcome.tookMs,
          disclaimer: QUERY_DISCLAIMER,
        };
      }
      return {
        ok: true,
        provider: outcome.provider,
        model: outcome.model,
        dsl: outcome.dsl,
        summary: describeQueryDsl(outcome.dsl),
        unconstrained: isUnconstrained(outcome.dsl),
        reason: null,
        message: null,
        issues: [],
        degradeTo: null,
        tookMs: outcome.tookMs,
        disclaimer: QUERY_DISCLAIMER,
      };
    },
  );

  app.post(
    '/api/v1/query/run',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(QUERY_ROLES)],
      schema: {
        tags: ['query'],
        summary: 'Run a filter. Takes a filter only — there is no natural-language input here.',
        description:
          'The filter is held to the same schema whether a model wrote it or an officer edited it. ' +
          'It executes inside a read-only transaction against a fully parameterised query; no model ' +
          'output is ever interpolated into SQL. An empty result is a 200 with an `emptyReason`.',
        body: RunRequest,
        response: { 200: RunResponse, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request): Promise<z.infer<typeof RunResponse>> => {
      const body = request.body;
      const result = await executor.run(body.dsl);

      await writeAudit(options.db, request.principal as Principal | undefined, {
        action: 'query.nl.run',
        targetType: 'query',
        targetId: body.dsl.entity,
        purpose: body.purpose,
        caseRef: body.case_ref ?? null,
        params: {
          text: body.text ?? null,
          dsl: body.dsl as unknown as Record<string, unknown>,
          summary: describeQueryDsl(body.dsl),
          emptyReason: result.emptyReason,
          unknownCameras: result.unknownCameras,
          unknownDistricts: result.unknownDistricts,
        },
        resultCount: result.rowCount,
      });

      return {
        entity: result.entity,
        sightings: result.sightings,
        cameras: result.cameras,
        resolvedPlates: result.resolvedPlates,
        unknownCameras: result.unknownCameras,
        unknownDistricts: result.unknownDistricts,
        rowCount: result.rowCount,
        emptyReason: result.emptyReason,
        sqlPreview: result.sqlPreview,
        tookMs: result.tookMs,
        disclaimer: result.disclaimer,
      };
    },
  );
}

/**
 * The catalogue vocabulary the model is grounded on.
 *
 * Bounded deliberately: a prompt is not a place to paste an estate of thousands of cameras, and the
 * question a control room asks names a handful. The console reports a name the estate does not
 * have rather than the model inventing a neighbouring one.
 */
async function loadVocabulary(db: Db): Promise<{ cameraExternalIds: string[]; districts: string[] }> {
  const rows = (await db.execute<{ external_id: string; district: string | null }>(sql`
    select external_id, district from cameras order by external_id limit 200
  `)) as unknown as { external_id: string; district: string | null }[];
  return {
    cameraExternalIds: rows.map((r) => r.external_id),
    districts: [...new Set(rows.map((r) => r.district).filter((d): d is string => d !== null))],
  };
}
