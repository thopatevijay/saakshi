import { z } from 'zod';

/**
 * Config contract. Every key here must exist in `.env.example` — the API reads nothing that a
 * fresh clone cannot discover. Values live in `.env` only and are never logged.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1).default('postgres://saakshi:saakshi@localhost:5432/saakshi'),
  // Connections per API instance. Sized against expected concurrency: at ~1 ms per query, N
  // connections serve roughly N,000 req/s, and anything beyond that queues — which is latency the
  // database never sees. Keep the total across instances below Postgres `max_connections` (100 on
  // the compose stack).
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(50),
  VALKEY_URL: z.string().min(1).default('redis://localhost:6379'),
  MINIO_ENDPOINT: z.string().min(1).default('http://localhost:9000'),
  MINIO_BUCKET: z.string().min(1).default('saakshi-evidence'),
  // Optional: the API must boot and serve the registry on a machine with no object store. Absent
  // credentials degrade the evidence feature; they do not fail the process. Read straight from
  // `process.env` by `evidenceStoreFromEnv`, never logged, never echoed.
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  MINIO_REGION: z.string().default('us-east-1'),
  QUERY_COMPILER: z.enum(['none', 'openai', 'anthropic', 'ollama']).default('none'),

  // The road graph, for D3-01's route reconstruction. Defaults to the compose `osrm` service.
  // Optional in effect rather than in type: a machine that has never run `scripts/import-osm.sh`
  // has no graph, every route query returns `null`, and the affected segments render as
  // `inferred_unroutable` with a reason. The trace itself is unaffected — a cold subsystem must not
  // take the answer down with it.
  OSRM_URL: z.string().min(1).default('http://localhost:5000'),
  // Per-query ceiling. A trace is interactive; an OSRM that has not answered in two seconds is
  // spending the request's budget, not about to rescue it.
  OSRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),

  // Bearer tokens are signed with this. The default is a development value and the deploy must
  // override it — D4-01 sets it from the platform's secret store.
  JWT_SECRET: z.string().min(8).default('saakshi-dev-jwt-secret'),

  // Upstream catalogue. `GET /api/ingest` is the contract; the URL shape is not, so it is
  // configuration rather than code. Optional: the API works without a sandbox attached.
  SENTINEL_HOST: z.string().optional(),
  SENTINEL_INGEST_URL: z.string().optional(),
  SENTINEL_PORTAL_COOKIE: z.string().optional(),
  // Overrides the stream URL shape entirely, for an estate whose URLs look nothing like the
  // sandbox's. `{external_id}` is substituted. Already read by the Python workers; the video wall's
  // relay resolves through the same rule, so both sides move together.
  SENTINEL_STREAM_TEMPLATE: z.string().optional(),
  // Scheduled catalogue re-sync, in minutes. 0 disables it, which is the default: a background job
  // that reaches an external host on a timer is something a deploy opts into.
  CATALOGUE_SYNC_INTERVAL_MIN: z.coerce.number().int().min(0).max(1440).default(0),

  // ── Video wall (D3-07) ────────────────────────────────────────────────────────────────────────
  // Our own MediaMTX edge gateway. WHEP is served from it, never from the government sandbox —
  // the sandbox is HLS-only (D1-03), and the `whep` adapter's honest status is `demonstrated`.
  MEDIAMTX_WHEP_BASE: z.string().default('http://localhost:8889'),
  MEDIAMTX_HLS_BASE: z.string().default('http://localhost:8888'),
  // The synthetic 640x360 / 25 fps source with a burnt-in timer that `ops/mediamtx/mediamtx.yml`
  // publishes on startup. It is how WHEP-vs-HLS latency is *measured* rather than asserted.
  MEDIAMTX_SELFTEST_PATH: z.string().default('saakshi-test'),
  // Relay ceilings. The gateway throttles under sustained load and each client gets its own copy of
  // the stream, so these are the knobs that keep nine tiles from becoming nine times the load.
  STREAM_RELAY_CACHE_MB: z.coerce.number().int().min(1).max(8192).default(256),
  STREAM_RELAY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  STREAM_RELAY_READ_AHEAD: z.coerce.number().int().min(0).max(16).default(3),
  // Wall-clock ceiling on one upstream request. Without one, a gateway that stops answering holds
  // a concurrency slot forever and the relay wedges — observed live on 2026-09-05.
  STREAM_RELAY_TIMEOUT_S: z.coerce.number().int().min(5).max(900).default(180),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Field names only. Never the values — see CLAUDE.md's `.env` rule.
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid environment configuration: ${fields}`);
  }
  return result.data;
}
