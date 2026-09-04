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
  QUERY_COMPILER: z.enum(['none', 'openai', 'anthropic', 'ollama']).default('none'),

  // Bearer tokens are signed with this. The default is a development value and the deploy must
  // override it — D4-01 sets it from the platform's secret store.
  JWT_SECRET: z.string().min(8).default('saakshi-dev-jwt-secret'),

  // Upstream catalogue. `GET /api/ingest` is the contract; the URL shape is not, so it is
  // configuration rather than code. Optional: the API works without a sandbox attached.
  SENTINEL_HOST: z.string().optional(),
  SENTINEL_INGEST_URL: z.string().optional(),
  SENTINEL_PORTAL_COOKIE: z.string().optional(),
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
